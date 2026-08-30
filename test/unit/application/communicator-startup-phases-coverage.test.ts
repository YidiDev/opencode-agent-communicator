import { describe, expect, test } from "bun:test";

import { runCommunicatorStartupPhases } from "../../../src/application/communicator-startup-phases";
import type { CommunicatorStartupRecoveryPorts } from "../../../src/application/communicator-startup-types";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid startup coverage fixture");
  return result.value;
}

const token = value(validateFencingToken(79));
const workspaceKey = value(validateWorkspaceKey("workspace:startup-coverage"));
const signal = new AbortController().signal;
const input = { workspaceKey, abort: signal, deadlineMs: 100, limit: 10 };
const barrier = { established: true as const, fencingToken: token };

function portsWithOptionalStartRecovery(includeOptional: boolean) {
  let startRetentionCalls = 0;
  const ports = {
    membership: {
      readCurrentRoots: async () => ({
        sourceVisible: true,
        targetVisible: true,
        sourceTitle: undefined,
      }),
    },
    deliveries: {
      listRecoverable: async () => [],
      garbageCollectMetadata: async () => ({
        ok: true as const,
        deletedDeliveries: 0,
        deletedRateEvents: 0,
      }),
    },
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
    requests: {
      listParticipantDeletionCandidates: async () => ({ ok: true as const, sessionIds: [] }),
      deleteAbsentParticipantRequests: async () => ({ ok: true as const, terminalized: [] }),
      listRecoverableRequests: async () => [],
      expireDueRequests: async () => ({ ok: true as const, requests: [] }),
    },
    participantPresence: { readParticipantPresence: async () => "present" as const },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "idle" as const,
      }),
    },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    ownership: { isCurrent: async () => true },
    startupBarrier: { establish: async () => barrier },
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
    starts: {
      listRecoverable: async () => [],
      collectRetention: async () => {
        startRetentionCalls += 1;
        return { ok: true as const, deletedOperations: 0, deletedRateEvents: 0 };
      },
    },
    nativeStart: { reconcileRootSession: async () => "unknown" as const },
    ...(includeOptional
      ? {
          requestStarts: { readSessionRequestStartByOperation: async () => null },
          digest: { sha256: async () => new Uint8Array(32) },
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
        }
      : {}),
  } as unknown as CommunicatorStartupRecoveryPorts;
  return { ports, startRetentionCalls: () => startRetentionCalls };
}

describe("communicator startup phase optional-port coverage", () => {
  test("runs without request-start, digest, or start-maintenance ports", async () => {
    const setup = portsWithOptionalStartRecovery(false);
    const result = await runCommunicatorStartupPhases(
      setup.ports,
      input,
      token,
      barrier,
      signal,
      async () => ({ ok: true, value: undefined }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        staleRequests: 0,
        preparedStartsAwaitingApproval: 0,
        retainedStartOperationsDeleted: 0,
        retainedStartRateEventsDeleted: 0,
      },
    });
    expect(setup.startRetentionCalls()).toBe(0);
  });

  test("forwards request-start and digest ports and drains optional start maintenance", async () => {
    const setup = portsWithOptionalStartRecovery(true);
    const result = await runCommunicatorStartupPhases(
      setup.ports,
      input,
      token,
      barrier,
      signal,
      async () => ({ ok: true, value: undefined }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        staleRequests: 0,
        retainedStartOperationsDeleted: 0,
        retainedStartRateEventsDeleted: 0,
      },
    });
    expect(setup.startRetentionCalls()).toBe(1);
  });

  test("propagates ownership verification at both startup checkpoints", async () => {
    for (const failureAt of [1, 2]) {
      const setup = portsWithOptionalStartRecovery(false);
      let checks = 0;
      const result = await runCommunicatorStartupPhases(
        setup.ports,
        input,
        token,
        barrier,
        signal,
        async () => {
          checks += 1;
          return checks === failureAt
            ? { ok: false as const, error: { code: "ownership_lost" as const } as never }
            : { ok: true as const, value: undefined };
        },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
      expect(checks).toBe(failureAt);
    }
  });
});
