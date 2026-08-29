import { expect, test } from "bun:test";

import { classifyStaleSessionRequests } from "../../../src/application/classify-stale-session-requests";
import { runCommunicatorStartupPhases } from "../../../src/application/communicator-startup-phases";
import { recoverSessionStarts } from "../../../src/application/recover-session-starts";
import type {
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "../../../src/application/request-ports";
import type { StartOperationPersistencePort } from "../../../src/application/session-start-ports";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import type { StartOperation } from "../../../src/domain/session-start";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { requestFixture } from "../../support/request-store";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const fencingToken = value(validateFencingToken(53));
const workspaceKey = value(validateWorkspaceKey("workspace:recovery-coverage"));
const sourceSessionId = value(validateSessionId("ses_source"));

function startOperation(index: number): StartOperation {
  return {
    id: value(validateStartOperationId(`op_${String(index).padStart(32, "0")}`)),
    workspaceKey,
    sourceSessionId,
    idempotencyKey: `recovery-coverage:${index}`,
    argumentsSha256: "0".repeat(64) as StartOperation["argumentsSha256"],
    sessionId: value(validateManagedSessionId(`ses_${String(index).padStart(32, "1")}`)),
    nativeMessageId: value(validateNativeMessageId(`msg_${String(index).padStart(32, "2")}`)),
    creationState: "prepared",
    titleState: "not_started",
    admissionState: "not_started",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function initialRequest(operation: StartOperation): RequestMetadata {
  return {
    id: value(validateRequestId(`req_${"5".repeat(32)}`)),
    workspaceKey,
    sourceSessionId,
    targetSessionId: operation.sessionId,
    nativeMessageId: operation.nativeMessageId,
    deliveryMode: "initial",
    linkedStartOperationId: operation.id,
    kind: "wait",
    resolutionState: "pending",
    deliveryState: "submitting",
    resultState: "none",
    payloadByteLength: 1,
    payloadSha256: "0".repeat(64),
    createdAtMs: 1,
    updatedAtMs: 2,
    deadlineAtMs: 1_000,
    submittedAtMs: 2,
  } as RequestMetadata;
}

function linkedRecoveryInput(
  operation: StartOperation,
  request: RequestMetadata,
  overrides: {
    readonly linked?: { readonly operation: StartOperation; readonly request: RequestMetadata };
    readonly claim?: unknown;
    readonly completion?: unknown;
  } = {},
) {
  return {
    fencingToken,
    workspaceKey,
    requestStarts: {
      readSessionRequestStartByOperation: async () =>
        overrides.linked === undefined ? { operation, request } : overrides.linked,
    } as never,
    requests: {
      claimPrepared: async () =>
        overrides.claim ?? { ok: true, request: { ...request, deliveryState: "submitting" } },
      completeDelivery: async () => overrides.completion ?? { ok: true, request },
    } as never,
    membership: {} as never,
    ownership: {} as never,
    digest: {} as never,
    nativeStart: {} as never,
  };
}

async function recoverLinked(
  operation: StartOperation,
  request: RequestMetadata,
  input = linkedRecoveryInput(operation, request),
) {
  const starts = {
    listRecoverable: async () => [operation],
  } as unknown as StartOperationPersistencePort;
  return recoverSessionStarts(starts, { nowMs: () => 9 }, input);
}

test("linked start recovery covers absent, terminal, and non-deliverable request boundaries", async () => {
  const operation = startOperation(1);
  const request = initialRequest(operation);

  const absent = {
    ...linkedRecoveryInput(operation, request),
    requestStarts: { readSessionRequestStartByOperation: async () => undefined } as never,
  };
  expect((await recoverLinked(operation, request, absent)).preparedAwaitingInvocationApproval).toBe(
    1,
  );

  expect(
    await recoverLinked(operation, request, {
      ...linkedRecoveryInput(operation, request),
      requestStarts: {
        readSessionRequestStartByOperation: async () => ({
          operation,
          request: { ...request, resolutionState: "cancelled" },
        }),
      } as never,
    }),
  ).toMatchObject({ preparedAwaitingInvocationApproval: 0 });

  expect(
    await recoverLinked(operation, request, {
      ...linkedRecoveryInput(operation, request),
      requestStarts: {
        readSessionRequestStartByOperation: async () => ({
          operation,
          request: { ...request, deliveryState: "admitted" },
        }),
      } as never,
    }),
  ).toMatchObject({ preparedAwaitingInvocationApproval: 0 });
});

test("linked start recovery covers prepared claims and durable terminal start outcomes", async () => {
  const base = startOperation(2);
  const submittingRequest = initialRequest(base);
  expect(
    await recoverLinked(base, submittingRequest, linkedRecoveryInput(base, submittingRequest)),
  ).toMatchObject({ preparedAwaitingInvocationApproval: 0 });
  await expect(
    recoverLinked(
      base,
      submittingRequest,
      linkedRecoveryInput(base, submittingRequest, { completion: { ok: false } }),
    ),
  ).rejects.toThrow("could not be completed");

  const preparedRequest = {
    ...initialRequest(base),
    deliveryState: "prepared",
  } as RequestMetadata;

  await expect(
    recoverLinked(
      base,
      preparedRequest,
      linkedRecoveryInput(base, preparedRequest, { claim: { ok: false } }),
    ),
  ).rejects.toThrow("could not be claimed");

  expect(
    await recoverLinked(
      base,
      preparedRequest,
      linkedRecoveryInput(base, preparedRequest, {
        claim: { ok: true, request: { ...preparedRequest, resolutionState: "cancelled" } },
      }),
    ),
  ).toMatchObject({ preparedAwaitingInvocationApproval: 0 });

  expect(
    await recoverLinked(
      base,
      preparedRequest,
      linkedRecoveryInput(base, preparedRequest, {
        claim: { ok: true, request: preparedRequest },
      }),
    ),
  ).toMatchObject({ preparedAwaitingInvocationApproval: 0 });

  const unknownAdmission = {
    ...base,
    creationState: "created" as const,
    titleState: "skipped" as const,
    admissionState: "admission_unknown" as const,
  };
  expect(
    await recoverLinked(
      unknownAdmission,
      preparedRequest,
      linkedRecoveryInput(unknownAdmission, preparedRequest),
    ),
  ).toMatchObject({ preparedAwaitingInvocationApproval: 0 });
  await expect(
    recoverLinked(
      unknownAdmission,
      preparedRequest,
      linkedRecoveryInput(unknownAdmission, preparedRequest, { completion: { ok: false } }),
    ),
  ).rejects.toThrow("could not be completed");

  for (const admissionState of ["admitted", "failed"] as const) {
    const terminal = {
      ...unknownAdmission,
      admissionState,
    };
    expect(
      await recoverLinked(
        terminal,
        preparedRequest,
        linkedRecoveryInput(terminal, preparedRequest),
      ),
    ).toMatchObject({ preparedAwaitingInvocationApproval: 0 });
  }
});

function staleInput(request: RequestMetadata): SessionRequestRecoveryPhaseInput {
  return {
    workspaceKey: request.workspaceKey,
    fencingToken,
    startupBarrier: { established: true, fencingToken },
    abort: new AbortController().signal,
    effectSignal: new AbortController().signal,
    deadlineMs: 10_000,
    limit: 10,
  };
}

function stalePorts(request: RequestMetadata, readLinked?: () => Promise<unknown>) {
  let listed = false;
  return {
    requests: {
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [request];
      },
      completeDelivery: async () => ({ ok: false, code: "state_conflict" }),
    },
    requestStarts: readLinked ? { readSessionRequestStartByOperation: readLinked } : undefined,
    ownership: { isCurrent: async () => true },
    notifications: { notifyTerminal() {} },
    clock: { nowMs: () => 4_000 },
  } as unknown as SessionRequestRecoveryPorts;
}

test("stale initial-request classification fails closed for missing and inconsistent linked starts", async () => {
  const fixture = await requestFixture(fencingToken, 4_000);
  const request = {
    ...fixture.request,
    deliveryMode: "initial" as const,
    linkedStartOperationId: fixture.creationOperationId,
    deliveryState: "submitting" as const,
    submittedAtMs: 4_001,
    updatedAtMs: 4_001,
  };
  const operation: StartOperation = {
    id: fixture.creationOperationId,
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    idempotencyKey: "stale-linked-start",
    argumentsSha256: "0".repeat(64) as StartOperation["argumentsSha256"],
    sessionId: request.targetSessionId,
    nativeMessageId: request.nativeMessageId,
    creationState: "created",
    titleState: "skipped",
    admissionState: "admission_unknown",
    createdAtMs: 4_000,
    updatedAtMs: 4_002,
  };

  const cases = [
    stalePorts(request),
    stalePorts(request, async () => undefined),
    stalePorts(request, async () => ({
      operation: { ...operation, sessionId: request.sourceSessionId },
    })),
    stalePorts(request, async () => ({
      operation: { ...operation, admissionState: "failed" },
      request,
    })),
    stalePorts(request, async () => ({
      operation: { ...operation, admissionState: "prepared" },
      request,
    })),
  ];
  for (const ports of cases) {
    expect(await classifyStaleSessionRequests(ports, staleInput(request))).toMatchObject({
      ok: false,
    });
  }
});

test("startup stops after stale classification when the deadline is reached", async () => {
  let now = 1;
  const ports = {
    membership: {},
    deliveries: { listRecoverable: async () => [] },
    nativeQueue: {},
    requests: {
      listParticipantDeletionCandidates: async () => ({ ok: true, sessionIds: [] }),
      deleteAbsentParticipantRequests: async () => ({ ok: true, terminalized: [] }),
      listRecoverableRequests: async () => {
        now = 100;
        return [];
      },
    },
    participantPresence: {},
    activity: {},
    nativeSteer: {},
    ownership: {},
    startupBarrier: {},
    clock: { nowMs: () => now },
    runtime: { notifyTerminal() {} },
    starts: { listRecoverable: async () => [] },
    nativeStart: {},
  } as never;
  const result = await runCommunicatorStartupPhases(
    ports,
    { workspaceKey, deadlineMs: 100, limit: 10 } as never,
    fencingToken,
    { established: true, fencingToken },
    new AbortController().signal,
    async () => ({ ok: true, value: undefined }),
  );
  expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});
