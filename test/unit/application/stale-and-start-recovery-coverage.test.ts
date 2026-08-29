import { describe, expect, test } from "bun:test";

import { classifyStaleSessionRequests } from "../../../src/application/classify-stale-session-requests";
import { recoverSessionStarts } from "../../../src/application/recover-session-starts";
import type {
  CompleteRequestDeliveryInput,
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "../../../src/application/request-ports";
import type { StartOperationPersistencePort } from "../../../src/application/session-start-ports";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import type { StartOperation } from "../../../src/domain/session-start";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { requestFixture } from "../../support/request-store";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid coverage fixture");
  return result.value;
}

const token = 73 as FencingToken;
const workspaceKey = value(validateWorkspaceKey("workspace:recovery-coverage"));
const sourceSessionId = value(validateSessionId("ses_source"));

function startOperation(
  index: number,
  states: Partial<Pick<StartOperation, "creationState" | "titleState" | "admissionState">> = {},
): StartOperation {
  return {
    id: value(validateStartOperationId(`op_${String(index).padStart(32, "0")}`)),
    workspaceKey,
    sourceSessionId,
    idempotencyKey: `focused-coverage:${index}`,
    argumentsSha256: "a".repeat(64) as StartOperation["argumentsSha256"],
    sessionId: value(validateManagedSessionId(`ses_${String(index).padStart(32, "1")}`)),
    nativeMessageId: value(validateNativeMessageId(`msg_${String(index).padStart(32, "2")}`)),
    creationState: "prepared",
    titleState: "not_started",
    admissionState: "not_started",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...states,
  } as StartOperation;
}

async function staleFixture() {
  const fixture = await requestFixture(token, 10_000);
  const request = {
    ...fixture.request,
    deliveryMode: "initial" as const,
    linkedStartOperationId: fixture.creationOperationId,
    deliveryState: "submitting" as const,
    submittedAtMs: 10_001,
    updatedAtMs: 10_001,
  } as RequestMetadata;
  const operation = {
    id: fixture.creationOperationId,
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    idempotencyKey: "linked-initial-coverage",
    argumentsSha256: "b".repeat(64) as StartOperation["argumentsSha256"],
    sessionId: request.targetSessionId,
    nativeMessageId: request.nativeMessageId,
    creationState: "created",
    titleState: "skipped",
    admissionState: "admission_unknown",
    createdAtMs: 10_000,
    updatedAtMs: 10_002,
  } as StartOperation;
  let listed = false;
  const input: SessionRequestRecoveryPhaseInput = {
    workspaceKey: request.workspaceKey,
    fencingToken: token,
    startupBarrier: { established: true, fencingToken: token },
    abort: new AbortController().signal,
    effectSignal: new AbortController().signal,
    deadlineMs: 99_000,
    limit: 10,
  };
  const ports = {
    requests: {
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [request];
      },
    },
    requestStarts: {
      readSessionRequestStartByOperation: async () => ({ operation, request }),
    },
    ownership: { isCurrent: async () => true },
    notifications: { notifyTerminal() {} },
    clock: { nowMs: () => 10_003 },
  } as unknown as SessionRequestRecoveryPorts;
  return { input, operation, ports, request };
}

function unknownRequest(request: RequestMetadata): RequestMetadata {
  return {
    ...request,
    deliveryState: "delivery_unknown",
    deliveryUnknownAtMs: 10_003,
    updatedAtMs: 10_003,
  } as RequestMetadata;
}

function failedRequest(request: RequestMetadata): RequestMetadata {
  const { payloadSha256: _payloadSha256, ...base } = request;
  return {
    ...base,
    resolutionState: "delivery_failed",
    deliveryState: "delivery_failed",
    deliveryFailedAtMs: 10_003,
    resolvedAtMs: 10_003,
    updatedAtMs: 10_003,
  } as RequestMetadata;
}

function replaceLinkedReader(
  ports: SessionRequestRecoveryPorts,
  reader: (...arguments_: never[]) => Promise<unknown>,
): void {
  Object.assign(ports, {
    requestStarts: { readSessionRequestStartByOperation: reader },
  });
}

describe("focused stale initial-request recovery coverage", () => {
  test("fails closed for missing, rejected, aborted, and malformed linked correlations", async () => {
    const missingPort = await staleFixture();
    delete (missingPort.ports as { requestStarts?: unknown }).requestStarts;
    expect(await classifyStaleSessionRequests(missingPort.ports, missingPort.input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const missingId = await staleFixture();
    const withoutId = { ...missingId.request } as RequestMetadata & {
      linkedStartOperationId?: StartOperation["id"];
    };
    delete withoutId.linkedStartOperationId;
    missingId.ports.requests.listRecoverableRequests = async () => [withoutId];
    expect(await classifyStaleSessionRequests(missingId.ports, missingId.input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    for (const linked of [null, Promise.reject(new Error("linked store unavailable"))]) {
      const setup = await staleFixture();
      replaceLinkedReader(setup.ports, async () => await linked);
      expect(await classifyStaleSessionRequests(setup.ports, setup.input)).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
    }

    const aborted = await staleFixture();
    const controller = new AbortController();
    replaceLinkedReader(aborted.ports, () => {
      controller.abort();
      return new Promise(() => undefined);
    });
    expect(
      await classifyStaleSessionRequests(aborted.ports, {
        ...aborted.input,
        effectSignal: controller.signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

    for (const operation of [
      { ...aborted.operation, id: value(validateStartOperationId(`op_${"9".repeat(32)}`)) },
      { ...aborted.operation, workspaceKey: value(validateWorkspaceKey("workspace:other")) },
      { ...aborted.operation, sourceSessionId },
      { ...aborted.operation, sessionId: aborted.request.sourceSessionId },
      {
        ...aborted.operation,
        nativeMessageId: value(validateNativeMessageId(`msg_${"8".repeat(32)}`)),
      },
      { ...aborted.operation, admissionState: "not_started" },
    ]) {
      const setup = await staleFixture();
      replaceLinkedReader(setup.ports, async () => ({ operation, request: setup.request }));
      expect(await classifyStaleSessionRequests(setup.ports, setup.input)).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
    }
  });

  test("maps admitted, unknown, and failed linked starts and emits terminal notification", async () => {
    for (const [states, outcome] of [
      [{ admissionState: "admitted" }, "admitted"],
      [{ admissionState: "admission_unknown" }, "delivery_unknown"],
      [{ admissionState: "failed" }, "delivery_failed"],
      [{ creationState: "failed", admissionState: "not_started" }, "delivery_failed"],
    ] as const) {
      const setup = await staleFixture();
      const events: unknown[] = [];
      setup.ports.notifications.notifyTerminal = (event) => {
        events.push(event);
      };
      replaceLinkedReader(setup.ports, async () => ({
        operation: { ...setup.operation, ...states },
        request: setup.request,
      }));
      setup.ports.requests.completeDelivery = (async (input: CompleteRequestDeliveryInput) => {
        expect(input.outcome).toBe(outcome);
        if (outcome === "delivery_failed") {
          return { ok: true, request: failedRequest(setup.request) };
        }
        if (outcome === "delivery_unknown") {
          return { ok: true, request: unknownRequest(setup.request) };
        }
        const observedAtMs =
          (input as CompleteRequestDeliveryInput & { evidenceObservedAtMs?: number })
            .evidenceObservedAtMs ?? 10_003;
        return {
          ok: true,
          request: {
            ...setup.request,
            deliveryState: "admitted",
            admittedAtMs: observedAtMs,
            updatedAtMs: observedAtMs,
            admissionEvidence: {
              state: "admitted",
              nativeMessageId: setup.request.nativeMessageId,
              admittedSeq: 0,
              observedAtMs,
            },
          },
        };
      }) as never;
      expect(await classifyStaleSessionRequests(setup.ports, setup.input)).toEqual({
        ok: true,
        value: 1,
      });
      expect(events).toHaveLength(outcome === "delivery_failed" ? 1 : 0);
    }
  });

  test("contains ownership, list, and completion store rejection boundaries", async () => {
    for (const [boundary, cause, code] of [
      ["ownership", new OwnershipLostFault("lease lost"), "ownership_lost"],
      ["ownership", new Error("ownership store rejected"), "storage_unavailable"],
      ["list", new OwnershipLostFault("lease lost"), "ownership_lost"],
      ["list", new Error("list store rejected"), "storage_unavailable"],
      ["completion", new Error("completion store rejected"), "storage_unavailable"],
    ] as const) {
      const setup = await staleFixture();
      if (boundary === "ownership")
        setup.ports.ownership.isCurrent = async () => Promise.reject(cause);
      if (boundary === "list")
        setup.ports.requests.listRecoverableRequests = async () => Promise.reject(cause);
      if (boundary === "completion") {
        setup.ports.requests.completeDelivery = async () => Promise.reject(cause);
      }
      expect(await classifyStaleSessionRequests(setup.ports, setup.input)).toMatchObject({
        ok: false,
        error: { code },
      });
    }
  });
});

function linkedRequest(operation: StartOperation, deliveryState: RequestMetadata["deliveryState"]) {
  return {
    id: value(
      // A request ID has the same generated identifier shape and a distinct validated prefix.
      // The cast keeps this fixture local without weakening production boundaries.
      { ok: true as const, value: `req_${operation.id.slice(3)}` as RequestMetadata["id"] },
    ),
    workspaceKey,
    sourceSessionId: operation.sourceSessionId,
    targetSessionId: operation.sessionId,
    nativeMessageId: operation.nativeMessageId,
    deliveryMode: "initial",
    linkedStartOperationId: operation.id,
    kind: "wait",
    resolutionState: "pending",
    deliveryState,
    resultState: "none",
    payloadByteLength: 1,
    payloadSha256: "c".repeat(64),
    createdAtMs: 1,
    updatedAtMs: deliveryState === "prepared" ? 1 : 2,
    deadlineAtMs: 100,
    ...(deliveryState === "prepared" ? {} : { submittedAtMs: 2 }),
    ...(deliveryState === "delivery_unknown" ? { deliveryUnknownAtMs: 2 } : {}),
  } as RequestMetadata;
}

function definitiveStartRecovery(
  operation: StartOperation,
  request: RequestMetadata,
  overrides: Record<string, unknown> = {},
) {
  const outcomes: string[] = [];
  const starts = {
    listRecoverable: async () => [operation],
  } as unknown as StartOperationPersistencePort;
  const input = {
    fencingToken: token,
    workspaceKey,
    requestStarts: {
      readSessionRequestStartByOperation: async () => ({ operation, request }),
    },
    requests: {
      claimPrepared: async () => ({
        ok: true as const,
        request: { ...request, deliveryState: "submitting", submittedAtMs: 2, updatedAtMs: 2 },
      }),
      completeDelivery: async (value: CompleteRequestDeliveryInput) => {
        outcomes.push(value.outcome);
        return { ok: true as const, request };
      },
    },
    membership: { readCurrentRoots: async () => ({ sourceVisible: true, targetVisible: true }) },
    ownership: { isCurrent: async () => true },
    digest: { sha256: async () => new Uint8Array(32) },
    nativeStart: {} as never,
    ...overrides,
  };
  return { input, outcomes, starts };
}

describe("focused linked start recovery coverage", () => {
  test("handles missing correlation and already terminal or irrelevant request states", async () => {
    const operation = startOperation(1);
    const request = linkedRequest(operation, "prepared");
    for (const overrides of [
      { requestStarts: undefined },
      { requests: undefined },
      { membership: undefined },
      { ownership: undefined },
      { digest: undefined },
      { nativeStart: undefined },
      { requestStarts: { readSessionRequestStartByOperation: async () => null } },
    ]) {
      const setup = definitiveStartRecovery(operation, request, overrides);
      expect(
        await recoverSessionStarts(setup.starts, { nowMs: () => 3 }, setup.input as never),
      ).toMatchObject({
        preparedAwaitingInvocationApproval: 1,
      });
    }

    for (const linked of [
      { ...request, resolutionState: "deadline_expired", resolvedAtMs: 100 },
      { ...request, deliveryState: "admitted" },
    ] as RequestMetadata[]) {
      const setup = definitiveStartRecovery(operation, linked);
      expect(
        await recoverSessionStarts(setup.starts, { nowMs: () => 3 }, setup.input as never),
      ).toMatchObject({
        preparedAwaitingInvocationApproval: 0,
      });
      expect(setup.outcomes).toEqual([]);
    }
  });

  test("settles prepared and submitting requests from unknown, admitted, and failed starts", async () => {
    for (const [admissionState, deliveryState, outcome] of [
      ["admission_unknown", "prepared", "delivery_unknown"],
      ["admitted", "submitting", "admitted"],
      ["failed", "submitting", "delivery_failed"],
    ] as const) {
      const operation = startOperation(2, {
        creationState: "created",
        titleState: "skipped",
        admissionState,
      });
      const request = linkedRequest(operation, deliveryState);
      const setup = definitiveStartRecovery(operation, request);
      expect(
        await recoverSessionStarts(setup.starts, { nowMs: () => 3 }, setup.input as never),
      ).toMatchObject({
        preparedAwaitingInvocationApproval: 0,
      });
      expect(setup.outcomes).toEqual([outcome]);
    }
  });

  test("rejects claim and completion store failures for definitive linked recovery", async () => {
    const preparedOperation = startOperation(3, {
      creationState: "created",
      titleState: "skipped",
      admissionState: "admitted",
    });
    const prepared = definitiveStartRecovery(
      preparedOperation,
      linkedRequest(preparedOperation, "prepared"),
      { requests: { claimPrepared: async () => ({ ok: false }) } },
    );
    await expect(
      recoverSessionStarts(prepared.starts, { nowMs: () => 3 }, prepared.input as never),
    ).rejects.toThrow("could not be claimed");

    const submittingOperation = startOperation(4, {
      creationState: "created",
      titleState: "skipped",
      admissionState: "failed",
    });
    const submitting = definitiveStartRecovery(
      submittingOperation,
      linkedRequest(submittingOperation, "submitting"),
      { requests: { completeDelivery: async () => ({ ok: false }) } },
    );
    await expect(
      recoverSessionStarts(submitting.starts, { nowMs: () => 3 }, submitting.input as never),
    ).rejects.toThrow("Definitive linked initial request could not be completed");
  });
});
