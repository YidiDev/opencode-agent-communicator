import { expect, test } from "bun:test";

import { acknowledgeSessionRequest } from "../../../src/application/acknowledge-session-request";
import { cancelSessionRequest } from "../../../src/application/cancel-session-request";
import type { RequestTerminalPersistencePort } from "../../../src/application/request-ports";
import { respondToSessionRequest } from "../../../src/application/respond-to-session-request";
import { signalSessionRequest } from "../../../src/application/signal-session-request";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import type { FencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata, RequestResolutionState } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("contract");
const foreignWorkspace = validateWorkspaceKey("contract-foreign");
const request = validateRequestId(`req_${"6".repeat(32)}`);
const otherRequest = validateRequestId(`req_${"7".repeat(32)}`);
const native = validateNativeMessageId(`msg_${"8".repeat(32)}`);
const source = validateSessionId("ses_source");
const target = validateSessionId("ses_target");
const other = validateSessionId("ses_other");
if (
  !workspace.ok ||
  !foreignWorkspace.ok ||
  !request.ok ||
  !otherRequest.ok ||
  !native.ok ||
  !source.ok ||
  !target.ok ||
  !other.ok
) {
  throw new Error("bad contract fixture");
}
const workspaceKey = workspace.value;
const foreignWorkspaceKey = foreignWorkspace.value;
const requestId = request.value;
const otherRequestId = otherRequest.value;
const nativeId = native.value;
const sourceId = source.value;
const targetId = target.value;
const otherId = other.value;
const digest = "d".repeat(64) as Sha256Digest;
const askResult = { kind: "ask" as const, answers: [["one"]] };
const waitResult = { kind: "wait" as const, evidence: "done" };

function unsuccessful(state: Exclude<RequestResolutionState, "pending" | "answered" | "reached">) {
  const resolvedAtMs = state === "deadline_expired" ? 100 : 8;
  const common = {
    id: requestId,
    workspaceKey,
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    nativeMessageId: nativeId,
    kind: "ask" as const,
    resultState: "none" as const,
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: resolvedAtMs,
    deadlineAtMs: 100,
    resolutionState: state,
    resolvedAtMs,
  };
  return state === "delivery_failed"
    ? ({
        ...common,
        deliveryState: "delivery_failed",
        submittedAtMs: 2,
        deliveryFailedAtMs: resolvedAtMs,
      } as RequestMetadata)
    : ({ ...common, deliveryState: "prepared" } as RequestMetadata);
}

function available(kind: "ask" | "wait"): RequestMetadata {
  const result = kind === "ask" ? askResult : waitResult;
  return {
    id: requestId,
    workspaceKey,
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    nativeMessageId: nativeId,
    kind,
    resolutionState: kind === "ask" ? "answered" : "reached",
    deliveryState: "prepared",
    resultState: "available",
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: 8,
    deadlineAtMs: 100,
    resolvedAtMs: 8,
    resultByteLength: new TextEncoder().encode(JSON.stringify(result)).length,
    resultSha256: digest,
    resultAvailableAtMs: 8,
    resultExpiresAtMs: 86_400_008,
  } as RequestMetadata;
}

function acknowledged(kind: "ask" | "wait"): RequestMetadata {
  const current = available(kind);
  if (current.resultState !== "available") throw new Error("bad available fixture");
  const { resultByteLength: _bytes, resultSha256: _digest, ...history } = current;
  return { ...history, updatedAtMs: 9, resultState: "acknowledged", acknowledgedAtMs: 9 };
}

function expired(): RequestMetadata {
  const current = available("ask");
  if (current.resultState !== "available") throw new Error("bad available fixture");
  const { resultByteLength: _bytes, resultSha256: _digest, ...history } = current;
  return {
    ...history,
    updatedAtMs: 86_400_008,
    resultState: "expired",
    resultExpiredAtMs: 86_400_008,
  };
}

function pending(kind: "ask" | "wait"): RequestMetadata {
  return {
    id: requestId,
    workspaceKey,
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    nativeMessageId: nativeId,
    kind,
    resolutionState: "pending",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: 1,
    payloadSha256: digest,
    createdAtMs: 1,
    updatedAtMs: 1,
    deadlineAtMs: 100,
  };
}

function fake(method: keyof RequestTerminalPersistencePort, returned: unknown) {
  const hidden = async () => ({ ok: false, code: "not_found_or_unauthorized" as const }) as never;
  const requests = {
    answerAsk: hidden,
    signalWait: hidden,
    cancelPending: hidden,
    acknowledgeResult: hidden,
  };
  requests[method] = async () => returned as never;
  let notified = 0;
  return {
    get notified() {
      return notified;
    },
    value: {
      readiness: { assertReady: () => undefined },
      clock: { nowMs: () => 0 },
      digest: { sha256: async () => new Uint8Array(32).fill(0xdd) },
      membership: {
        readCurrentRoots: async () => ({
          sourceTitle: undefined,
          sourceVisible: true,
          targetVisible: false,
        }),
      },
      requests,
      notifications: {
        notifyTerminal: (): undefined => {
          notified++;
          return undefined;
        },
      },
    },
  };
}

const context = {
  workspaceKey,
  callerSessionId: targetId,
  fencingToken: 5 as FencingToken,
  abort: new AbortController().signal,
  deadlineMs: 100,
};
const storageFailure = { ok: false, error: { code: "storage_unavailable", retryable: true } };

test("respond fails closed for every success contract field and retained result violation", async () => {
  const valid = available("ask");
  const candidates: unknown[] = [
    { ok: true, outcome: "idempotent", request: valid, result: askResult },
    { ok: true, outcome: "applied", request: valid, result: askResult, extra: true },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, workspaceKey: foreignWorkspaceKey },
      result: askResult,
    },
    { ok: true, outcome: "applied", request: { ...valid, id: otherRequestId }, result: askResult },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, targetSessionId: otherId },
      result: askResult,
    },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, nativeMessageId: "bad" },
      result: askResult,
    },
    { ok: true, outcome: "applied", request: { ...valid, kind: "wait" }, result: askResult },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, resolutionState: "reached" },
      result: askResult,
    },
    { ok: true, outcome: "applied", request: { ...valid, resultState: "none" }, result: askResult },
    { ok: true, outcome: "applied", request: { ...valid, resolvedAtMs: 9 }, result: askResult },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, resultExpiresAtMs: 9 },
      result: askResult,
    },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, resultSha256: "e".repeat(64) },
      result: askResult,
    },
    { ok: true, outcome: "applied", request: valid, result: { kind: "ask", answers: "bad" } },
    { ok: true, outcome: "applied", request: valid, result: waitResult },
    { ok: true, outcome: "applied", request: valid, result: { kind: "ask", answers: [["two"]] } },
    { ok: true, outcome: "applied", request: { ...valid, resultByteLength: 1 }, result: askResult },
  ];
  for (const candidate of candidates) {
    const mock = fake("answerAsk", candidate);
    expect(
      await respondToSessionRequest(mock.value, context, {
        request_id: requestId,
        answers: [["one"]],
      }),
    ).toMatchObject(storageFailure);
    expect(mock.notified).toBe(0);
  }
});

test("signal validates wait kind, reached state, result state, result shape, and participant", async () => {
  const valid = available("wait");
  for (const candidate of [
    { ok: true, outcome: "applied", request: { ...valid, kind: "ask" }, result: waitResult },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, resolutionState: "answered" },
      result: waitResult,
    },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, resultState: "expired" },
      result: waitResult,
    },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, targetSessionId: otherId },
      result: waitResult,
    },
    {
      ok: true,
      outcome: "applied",
      request: { ...valid, resultSha256: "e".repeat(64) },
      result: waitResult,
    },
    { ok: true, outcome: "applied", request: valid, result: { kind: "wait", evidence: 1 } },
    { ok: true, outcome: "applied", request: valid, result: askResult },
    { ok: true, outcome: "applied", request: valid, result: { kind: "wait", evidence: "nope" } },
  ]) {
    const mock = fake("signalWait", candidate);
    expect(
      await signalSessionRequest(mock.value, context, { request_id: requestId, evidence: "done" }),
    ).toMatchObject(storageFailure);
    expect(mock.notified).toBe(0);
  }

  for (const [submittedEvidence, returnedResult] of [
    [undefined, { kind: "wait" as const, evidence: "" }],
    ["", { kind: "wait" as const }],
  ] as const) {
    const requestMetadata = {
      ...valid,
      resultByteLength: new TextEncoder().encode(JSON.stringify(returnedResult)).length,
    };
    const mock = fake("signalWait", {
      ok: true,
      outcome: "applied",
      request: requestMetadata,
      result: returnedResult,
    });
    expect(
      await signalSessionRequest(mock.value, context, {
        request_id: requestId,
        ...(submittedEvidence === undefined ? {} : { evidence: submittedEvidence }),
      }),
    ).toMatchObject(storageFailure);
    expect(mock.notified).toBe(0);
  }
});

test("cancel requires exact outcome, resolution discriminator, metadata state, and source", async () => {
  const cancelled = unsuccessful("cancelled");
  const answered = available("ask");
  for (const candidate of [
    { ok: true, outcome: "applied", resolutionState: "answered", request: answered },
    { ok: true, outcome: "idempotent", resolutionState: "answered", request: answered },
    { ok: true, outcome: "terminal_state", resolutionState: "cancelled", request: cancelled },
    { ok: true, outcome: "terminal_state", resolutionState: "reached", request: answered },
    { ok: true, outcome: "other", resolutionState: "cancelled", request: cancelled },
    {
      ok: true,
      outcome: "applied",
      resolutionState: "cancelled",
      request: { ...cancelled, sourceSessionId: otherId },
    },
    { ok: true, outcome: "applied", resolutionState: "cancelled", request: pending("ask") },
  ]) {
    const mock = fake("cancelPending", candidate);
    expect(
      await cancelSessionRequest(
        mock.value,
        { ...context, callerSessionId: sourceId },
        { request_id: requestId },
      ),
    ).toMatchObject(storageFailure);
    expect(mock.notified).toBe(0);
  }
});

test("ack accepts only exact acknowledged answered/reached metadata and rejects every other state", async () => {
  for (const kind of ["ask", "wait"] as const) {
    const mock = fake("acknowledgeResult", {
      ok: true,
      outcome: "applied",
      request: acknowledged(kind),
    });
    expect(
      await acknowledgeSessionRequest(
        mock.value,
        { ...context, callerSessionId: sourceId },
        { request_id: requestId },
      ),
    ).toMatchObject({ ok: true, value: { state: "acknowledged", acknowledged_at_ms: 9 } });
  }
  for (const requestMetadata of [
    pending("ask"),
    available("ask"),
    expired(),
    ...(
      [
        "cancelled",
        "deadline_expired",
        "delivery_failed",
        "target_stopped",
        "source_stopped",
        "target_deleted",
        "source_deleted",
      ] as const
    ).map(unsuccessful),
    { ...acknowledged("ask"), acknowledgedAtMs: -1 },
    { ...acknowledged("ask"), sourceSessionId: otherId },
  ]) {
    const mock = fake("acknowledgeResult", {
      ok: true,
      outcome: "idempotent",
      request: requestMetadata,
    });
    expect(
      await acknowledgeSessionRequest(
        mock.value,
        { ...context, callerSessionId: sourceId },
        { request_id: requestId },
      ),
    ).toMatchObject(storageFailure);
  }
});

test("unknown codes and malformed failure/result envelopes fail closed exactly", async () => {
  for (const returned of [
    undefined,
    false,
    { ok: true },
    { ok: false, code: "unknown" },
    { ok: false, code: "storage_unavailable", extra: true },
    { ok: false, code: "state_conflict", request: { private: "value" } },
    { ok: false, code: "state_conflict", request: available("ask"), extra: true },
  ]) {
    const mock = fake("answerAsk", returned);
    const result = await respondToSessionRequest(mock.value, context, {
      request_id: requestId,
      answers: [["one"]],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "storage_unavailable",
        message: "Request storage is unavailable.",
        retryable: true,
      },
    });
    expect(mock.notified).toBe(0);
  }
});

test("cancel maps correlated authoritative conflicts while ack remains a state conflict", async () => {
  for (const [method, requestMetadata, invoke, expected, expectedNotifications] of [
    [
      "cancelPending",
      unsuccessful("cancelled"),
      (mock: ReturnType<typeof fake>) =>
        cancelSessionRequest(
          mock.value,
          { ...context, callerSessionId: sourceId },
          { request_id: requestId },
        ),
      {
        ok: true,
        value: { request_id: requestId, state: "cancelled", cancelled_at_ms: 8 },
      },
      1,
    ],
    [
      "acknowledgeResult",
      acknowledged("ask"),
      (mock: ReturnType<typeof fake>) =>
        acknowledgeSessionRequest(
          mock.value,
          { ...context, callerSessionId: sourceId },
          { request_id: requestId },
        ),
      {
        ok: false,
        error: {
          code: "state_conflict",
          message: "Request state does not allow this operation.",
          retryable: false,
        },
      },
      0,
    ],
  ] as const) {
    const correlated = fake(method, {
      ok: false,
      code: "state_conflict",
      request: requestMetadata,
    });
    expect(await invoke(correlated)).toEqual(expected);
    expect(correlated.notified).toBe(expectedNotifications);

    const mismatched = fake(method, {
      ok: false,
      code: "state_conflict",
      request: { ...requestMetadata, sourceSessionId: otherId },
    });
    expect(await invoke(mismatched)).toMatchObject(storageFailure);
    expect(mismatched.notified).toBe(0);
  }
});
