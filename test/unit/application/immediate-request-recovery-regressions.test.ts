import { expect, test } from "bun:test";

import { admitClaimedSessionRequest } from "../../../src/application/admit-claimed-session-request";
import { classifyStaleSessionRequests } from "../../../src/application/classify-stale-session-requests";
import { recoverOnePreparedSessionRequest } from "../../../src/application/recover-one-prepared-session-request";
import type { RequestAdmissionPersistencePort } from "../../../src/application/request-ports";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import type { StartOperation } from "../../../src/domain/session-start";
import { requestFixture } from "../../support/request-store";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const token = valid(validateFencingToken(41));

test("startup recovery queues a prepared idle-target request exactly once", async () => {
  const fixture = await requestFixture(token);
  const prepared = { ...fixture.request, deliveryMode: "queue" as const };
  const submitting = {
    ...prepared,
    deliveryState: "submitting" as const,
    submittedAtMs: 1_001,
    updatedAtMs: 1_001,
  };
  let queueCalls = 0;
  let steerCalls = 0;
  const requests = {
    async claimPrepared() {
      return { ok: true as const, request: submitting, envelopeJson: fixture.envelopeJson };
    },
    async completeDelivery(input: { outcome: string; evidenceObservedAtMs?: number }) {
      expect(input.outcome).toBe("admitted");
      const observedAtMs = input.evidenceObservedAtMs ?? 1_002;
      return {
        ok: true as const,
        request: {
          ...submitting,
          deliveryState: "admitted" as const,
          admittedAtMs: observedAtMs,
          updatedAtMs: observedAtMs,
          admissionEvidence: {
            state: "admitted" as const,
            nativeMessageId: submitting.nativeMessageId,
            admittedSeq: 7,
            observedAtMs,
          },
        },
      };
    },
  } as unknown as RequestAdmissionPersistencePort;
  const result = await recoverOnePreparedSessionRequest(
    {
      requests: requests as never,
      activity: {
        async observeRequestParticipants() {
          return { sourceVisible: true, targetVisible: true, targetStatus: "idle" };
        },
      },
      nativeSteer: {
        async steerRequest() {
          steerCalls += 1;
          return { kind: "unknown" };
        },
      },
      nativeQueue: {
        async queueMessage() {
          queueCalls += 1;
          return { kind: "admitted", admittedSeq: 7, observedAtMs: 1_002 };
        },
      },
      ownership: { acquire: async () => token, isCurrent: async () => true },
      notifications: { notifyTerminal: () => undefined },
      clock: { nowMs: () => 1_002 },
    },
    {
      workspaceKey: prepared.workspaceKey,
      fencingToken: token,
      startupBarrier: { established: true, fencingToken: token },
      limit: 10,
      abort: new AbortController().signal,
      deadlineMs: 10_000,
      effectSignal: new AbortController().signal,
    },
    prepared,
  );
  expect(result).toEqual({ ok: true, value: "submitted" });
  expect(queueCalls).toBe(1);
  expect(steerCalls).toBe(0);
});

test("missing persisted-mode queue port fails closed without steering", async () => {
  const fixture = await requestFixture(token, 2_000);
  const request = {
    ...fixture.request,
    deliveryMode: "queue" as const,
    deliveryState: "submitting" as const,
    submittedAtMs: 2_001,
    updatedAtMs: 2_001,
  };
  let steerCalls = 0;
  const result = await admitClaimedSessionRequest(
    {
      requests: {} as RequestAdmissionPersistencePort,
      nativeSteer: {
        async steerRequest() {
          steerCalls += 1;
          return { kind: "unknown" };
        },
      },
      ownership: { acquire: async () => token, isCurrent: async () => true },
      notifications: { notifyTerminal: () => undefined },
      clock: { nowMs: () => 2_002 },
    },
    {
      workspaceKey: request.workspaceKey,
      fencingToken: token,
      request: request as RequestMetadata & { readonly deliveryState: "submitting" },
      envelope: fixture.envelopeJson,
      control: { abort: new AbortController().signal, deadlineMs: 10_000 },
      effectSignal: new AbortController().signal,
    },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  expect(steerCalls).toBe(0);
});

test("startup reconciles a submitting initial request from definitive admitted start state", async () => {
  const fixture = await requestFixture(token, 3_000);
  const request = {
    ...fixture.request,
    deliveryMode: "initial" as const,
    linkedStartOperationId: fixture.creationOperationId,
    deliveryState: "submitting" as const,
    submittedAtMs: 3_001,
    updatedAtMs: 3_001,
  };
  const operation: StartOperation = {
    id: fixture.creationOperationId,
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    idempotencyKey: "terminal-admission",
    argumentsSha256: "0".repeat(64) as StartOperation["argumentsSha256"],
    sessionId: request.targetSessionId,
    nativeMessageId: request.nativeMessageId,
    creationState: "created",
    titleState: "skipped",
    admissionState: "admitted",
    createdAtMs: 3_000,
    updatedAtMs: 3_002,
  };
  let completed = false;
  const requests = {
    async listRecoverableRequests() {
      return completed ? [] : [request];
    },
    async completeDelivery(input: { outcome: string; evidenceObservedAtMs?: number }) {
      expect(input.outcome).toBe("admitted");
      completed = true;
      const observedAtMs = input.evidenceObservedAtMs ?? 3_003;
      return {
        ok: true as const,
        request: {
          ...request,
          deliveryState: "admitted" as const,
          admittedAtMs: observedAtMs,
          updatedAtMs: observedAtMs,
          admissionEvidence: {
            state: "admitted" as const,
            nativeMessageId: request.nativeMessageId,
            admittedSeq: 0,
            observedAtMs,
          },
        },
      };
    },
  };
  const result = await classifyStaleSessionRequests(
    {
      requests: requests as never,
      activity: {} as never,
      nativeSteer: {} as never,
      requestStarts: {
        async readSessionRequestStartByOperation() {
          return { operation, request };
        },
      },
      ownership: { acquire: async () => token, isCurrent: async () => true },
      notifications: { notifyTerminal: () => undefined },
      clock: { nowMs: () => 3_003 },
    },
    {
      workspaceKey: request.workspaceKey,
      fencingToken: token,
      startupBarrier: { established: true, fencingToken: token },
      limit: 10,
      abort: new AbortController().signal,
      deadlineMs: 10_000,
      effectSignal: new AbortController().signal,
    },
  );
  expect(result).toEqual({ ok: true, value: 1 });
  expect(completed).toBe(true);
});
