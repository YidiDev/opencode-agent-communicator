import { describe, expect, test } from "bun:test";

import type { CommunicatorStartupRecoveryPorts } from "../../../src/application/communicator-startup-types";
import { recoverCommunicatorStartup } from "../../../src/application/recover-communicator-startup";
import { recoverPreparedMessageDeliveries } from "../../../src/application/recover-message-delivery-phases";
import { RequestRuntime } from "../../../src/application/request-runtime";
import type { SessionStartPorts } from "../../../src/application/session-start-application";
import { reconcileStartCreation } from "../../../src/application/start-session-effects";
import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import {
  validateDeliveryId,
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { StartOperation } from "../../../src/domain/session-start";
import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid lifecycle-refactor fixture");
  return result.value;
}

const token = value(validateFencingToken(61));
const workspaceKey = value(validateWorkspaceKey("workspace:lifecycle-refactor-coverage"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const operationId = value(validateStartOperationId(`op_${"1".repeat(32)}`));
const managedSessionId = value(validateManagedSessionId(`ses_${"2".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"3".repeat(32)}`));

function startupPorts(): CommunicatorStartupRecoveryPorts {
  return {
    membership: {
      readCurrentRoots: async () => ({
        sourceVisible: true,
        targetVisible: true,
        sourceTitle: "source",
      }),
    },
    deliveries: {
      listRecoverable: async () => [],
      garbageCollectMetadata: async () => ({
        ok: true,
        deletedDeliveries: 0,
        deletedRateEvents: 0,
      }),
    } as never,
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" }) },
    requests: {
      listParticipantDeletionCandidates: async () => ({ ok: true, sessionIds: [] }),
      deleteAbsentParticipantRequests: async () => ({ ok: true, terminalized: [] }),
      listRecoverableRequests: async () => [],
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 1, maximumSleepMs: 10 }),
    } as never,
    participantPresence: { readParticipantPresence: async () => "present" },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "idle",
      }),
    },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" }) },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    startupBarrier: {
      establish: async () => ({ established: true as const, fencingToken: token }),
    },
    clock: { nowMs: () => 1 },
    runtime: new RequestRuntime(),
    resultRetention: {
      expireAvailableResults: async () => ({ ok: true as const, requests: [] }),
    },
    requestRetention: {
      collectRequestRetention: async () => ({
        ok: true as const,
        deletedRequests: 0,
        deletedRateEvents: 0,
      }),
    },
    starts: { listRecoverable: async () => [] } as never,
    startLimits: {
      managedSessionsPerWorkspace: 64,
      unresolvedProvenancePerWorkspace: 16,
      operationsPerWorkspace: 4_096,
      payloadBytesPerWorkspace: 8 * 1_024 * 1_024,
      startsPerSourceWindow: 5,
      startsPerWorkspaceWindow: 25,
      rateWindowMs: 60_000,
      terminalRetentionMs: 86_400_000,
    },
    nativeStart: { reconcileRootSession: async () => "unknown" } as never,
  } as CommunicatorStartupRecoveryPorts;
}

function startupInput() {
  return {
    workspaceKey,
    abort: new AbortController().signal,
    deadlineMs: 100,
    limit: 10,
    timers: { set: () => 1, clear() {} },
    startupTimers: { set: () => 1, clear() {} },
    nowMonotonicMs: () => 1,
  };
}

describe("lifecycle refactor startup coverage", () => {
  test("maps both ownership and storage start-maintenance failures", async () => {
    for (const code of ["ownership_lost", "storage_unavailable"] as const) {
      const ports = startupPorts();
      ports.starts.collectRetention = async () => ({ ok: false, code });

      expect(await recoverCommunicatorStartup(ports, startupInput())).toMatchObject({
        ok: false,
        error: { code },
      });
    }
  });

  test("rechecks lifecycle control after successful start maintenance", async () => {
    let now = 1;
    const ports = startupPorts();
    ports.clock.nowMs = () => now;
    ports.starts.collectRetention = async () => {
      now = 100;
      return { ok: true, deletedOperations: 0, deletedRateEvents: 0 };
    };

    expect(await recoverCommunicatorStartup(ports, startupInput())).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
  });
});

function delivery(): DeliveryMetadata {
  return {
    id: value(validateDeliveryId(`dlv_${"4".repeat(32)}`)),
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId,
    state: "prepared",
    contentByteLength: 1,
    contentSha256: "a".repeat(64) as Sha256Digest,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function recoveryInput(abort: AbortSignal) {
  return {
    workspaceKey,
    fencingToken: token,
    startupBarrier: { established: true as const, fencingToken: token },
    abort,
    limit: 10,
  };
}

describe("lifecycle refactor delivery recovery coverage", () => {
  test("contains an abort during the final empty-page exhaustion probe", async () => {
    const controller = new AbortController();
    let reads = 0;
    const ports = {
      clock: { nowMs: () => 1 },
      deliveries: {
        listRecoverable: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve([]);
          controller.abort();
          return new Promise<readonly DeliveryMetadata[]>(() => undefined);
        },
      },
    } as never;

    expect(
      await recoverPreparedMessageDeliveries(ports, recoveryInput(controller.signal)),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });

  test("rejects a malformed final exhaustion snapshot", async () => {
    let reads = 0;
    const sparse = new Array<DeliveryMetadata>(1);
    const ports = {
      clock: { nowMs: () => 1 },
      deliveries: { listRecoverable: async () => (++reads === 1 ? [] : sparse) },
    } as never;

    expect(
      await recoverPreparedMessageDeliveries(ports, recoveryInput(new AbortController().signal)),
    ).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  });

  test("stops between listing a prepared record and recovering it", async () => {
    let clockReads = 0;
    const ports = {
      clock: { nowMs: () => (++clockReads === 1 ? 1 : 100) },
      deliveries: { listRecoverable: async () => [delivery()] },
    } as never;

    expect(
      await recoverPreparedMessageDeliveries(ports, {
        ...recoveryInput(new AbortController().signal),
        deadlineMs: 100,
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });
});

function unknownCreation(): StartOperation {
  return {
    id: operationId,
    workspaceKey,
    sourceSessionId,
    idempotencyKey: "lifecycle-refactor",
    argumentsSha256: "b".repeat(64) as StartOperation["argumentsSha256"],
    sessionId: managedSessionId,
    nativeMessageId,
    creationState: "outcome_unknown",
    titleState: "not_started",
    admissionState: "not_started",
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function startPorts() {
  const stopped: string[] = [];
  const operation = unknownCreation();
  const ports = {
    readiness: {
      fencingToken: token,
      assertReady() {},
      ownershipLost: () => stopped.push("ownership_lost"),
    },
    membership: { readCurrentRoots: async () => ({}) },
    approval: { requestStartApproval: async () => "approved" },
    starts: {
      reconcileUnknownCreation: async () => ({
        ok: true as const,
        operation: { ...operation, creationState: "created", updatedAtMs: 3 },
      }),
    },
    nativeStart: {
      reconcileRootSession: async () => "matching" as const,
    },
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    clock: { nowMs: () => 3 },
    ids: {} as never,
    digest: { sha256: async () => new Uint8Array(32) },
    policy: createSessionStartPolicy({ decision: "allow" }),
  } as unknown as SessionStartPorts;
  return { operation, ports, stopped };
}

const startContext = {
  workspaceKey,
  sourceSessionId,
  abort: new AbortController().signal,
  deadlineMs: 100,
};

describe("lifecycle refactor start reconciliation coverage", () => {
  test("validates native reconciliation outcomes and preserves unknown outcomes", async () => {
    const malformed = startPorts();
    malformed.ports.nativeStart.reconcileRootSession = async () => "future" as never;
    await expect(
      reconcileStartCreation(malformed.ports, startContext, token, malformed.operation),
    ).rejects.toThrow("unknown outcome");

    const unknown = startPorts();
    unknown.ports.nativeStart.reconcileRootSession = async () => "unknown";
    expect(
      await reconcileStartCreation(unknown.ports, startContext, token, unknown.operation),
    ).toMatchObject({ ok: false, error: { code: "native_outcome_unknown" } });
  });

  test("stops the readiness lifecycle when reconciliation observes ownership loss", async () => {
    const fixture = startPorts();
    fixture.ports.ownership.isCurrent = async () => false;

    expect(
      await reconcileStartCreation(fixture.ports, startContext, token, fixture.operation),
    ).toMatchObject({ ok: false, error: { code: "native_outcome_unknown" } });
    expect(fixture.stopped).toEqual(["ownership_lost"]);
  });

  test("maps reconciliation persistence failures and rejects malformed success", async () => {
    const rejected = startPorts();
    rejected.ports.starts.reconcileUnknownCreation = async () => ({
      ok: false,
      code: "storage_unavailable",
    });
    expect(
      await reconcileStartCreation(rejected.ports, startContext, token, rejected.operation),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

    const thrown = startPorts();
    thrown.ports.starts.reconcileUnknownCreation = async () => {
      throw new Error("private store failure");
    };
    expect(
      await reconcileStartCreation(thrown.ports, startContext, token, thrown.operation),
    ).toMatchObject({ ok: false, error: { code: "native_outcome_unknown" } });

    const malformed = startPorts();
    malformed.ports.starts.reconcileUnknownCreation = async () => ({
      ok: true,
      operation: {
        ...malformed.operation,
        id: value(validateStartOperationId(`op_${"9".repeat(32)}`)),
      },
    });
    await expect(
      reconcileStartCreation(malformed.ports, startContext, token, malformed.operation),
    ).rejects.toThrow("reconciliation result is malformed");
  });
});
