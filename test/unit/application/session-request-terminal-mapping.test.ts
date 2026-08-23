import { expect, test } from "bun:test";

import { acknowledgeSessionRequest } from "../../../src/application/acknowledge-session-request";
import { cancelSessionRequest } from "../../../src/application/cancel-session-request";
import type { RequestTerminalPersistencePort } from "../../../src/application/request-ports";
import { respondToSessionRequest } from "../../../src/application/respond-to-session-request";
import { signalSessionRequest } from "../../../src/application/signal-session-request";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import type { FencingToken } from "../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata, RequestResolutionState } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspaceValue = validateWorkspaceKey("mapping");
const requestValue = validateRequestId(`req_${"d".repeat(32)}`);
const nativeValue = validateNativeMessageId(`msg_${"e".repeat(32)}`);
const sourceValue = validateSessionId("ses_source");
const targetValue = validateSessionId("ses_target");
if (
  !workspaceValue.ok ||
  !requestValue.ok ||
  !nativeValue.ok ||
  !sourceValue.ok ||
  !targetValue.ok
) {
  throw new Error("bad mapping fixture");
}
const workspace = workspaceValue.value;
const requestId = requestValue.value;
const nativeId = nativeValue.value;
const source = sourceValue.value;
const target = targetValue.value;
const token = 2 as FencingToken;
const context = {
  workspaceKey: workspace,
  callerSessionId: target,
  fencingToken: token,
  abort: new AbortController().signal,
  deadlineMs: 1_000_000_000,
};

function metadata(state: RequestResolutionState): RequestMetadata {
  const resolvedAtMs = state === "deadline_expired" ? 100_000_000 : 9;
  const base = {
    id: requestId,
    workspaceKey: workspace,
    sourceSessionId: source,
    targetSessionId: target,
    nativeMessageId: nativeId,
    kind: state === "reached" ? "wait" : "ask",
    deliveryState: "prepared" as const,
    resultState: "none" as const,
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: resolvedAtMs,
    deadlineAtMs: 100_000_000,
  };
  if (state === "pending") {
    return {
      ...base,
      resolutionState: state,
      payloadSha256: "f".repeat(64) as Sha256Digest,
    } as RequestMetadata;
  }
  if (state === "answered" || state === "reached") {
    return {
      ...base,
      kind: state === "answered" ? "ask" : "wait",
      resolutionState: state,
      resolvedAtMs,
      resultState: "available",
      resultByteLength: new TextEncoder().encode(
        JSON.stringify(
          state === "answered" ? { kind: "ask", answers: [["ok"]] } : { kind: "wait" },
        ),
      ).length,
      resultSha256: "f".repeat(64) as Sha256Digest,
      resultAvailableAtMs: resolvedAtMs,
      resultExpiresAtMs: resolvedAtMs + 86_400_000,
    } as RequestMetadata;
  }
  if (state === "delivery_failed") {
    return {
      ...base,
      deliveryState: "delivery_failed",
      submittedAtMs: 2,
      deliveryFailedAtMs: resolvedAtMs,
      resolutionState: state,
      resolvedAtMs,
    } as RequestMetadata;
  }
  return { ...base, resolutionState: state, resolvedAtMs } as RequestMetadata;
}

function acknowledgedMetadata(atMs: number): RequestMetadata {
  const available = metadata("answered");
  if (available.resolutionState !== "answered" || available.resultState !== "available") {
    throw new Error("bad available fixture");
  }
  const { resultByteLength: _bytes, resultSha256: _digest, ...historical } = available;
  return {
    ...historical,
    updatedAtMs: atMs,
    resultState: "acknowledged",
    acknowledgedAtMs: atMs,
  };
}

function ports(requests: RequestTerminalPersistencePort, notify?: (...args: unknown[]) => void) {
  return {
    readiness: { assertReady: () => undefined },
    clock: { nowMs: () => 0 },
    digest: { sha256: async () => new Uint8Array(32).fill(0xff) },
    membership: {
      readCurrentRoots: async () => ({
        sourceTitle: undefined,
        sourceVisible: true,
        targetVisible: false,
      }),
    },
    requests,
    notifications: {
      notifyTerminal: (...args: unknown[]): undefined => {
        notify?.(...args);
        return undefined;
      },
    },
  };
}

function terminalPort(state: RequestResolutionState): RequestTerminalPersistencePort {
  const request = metadata(state);
  return {
    answerAsk: async () => ({ ok: false, code: "state_conflict", request }),
    signalWait: async () => ({ ok: false, code: "state_conflict", request }),
    cancelPending: async () =>
      state === "cancelled"
        ? {
            ok: true,
            outcome: "idempotent",
            resolutionState: "cancelled",
            request: request as never,
          }
        : state === "pending"
          ? { ok: false, code: "state_conflict" }
          : ({
              ok: true,
              outcome: "terminal_state",
              resolutionState: state,
              request,
            } as never),
    acknowledgeResult: async () => ({ ok: false, code: "state_conflict" }),
  };
}

const terminalCases = [
  ["answered", "request_not_pending"],
  ["reached", "request_not_pending"],
  ["cancelled", "request_cancelled"],
  ["deadline_expired", "deadline_expired"],
  ["delivery_failed", "delivery_failed"],
  ["target_stopped", "target_stopped"],
  ["source_stopped", "source_stopped"],
  ["target_deleted", "target_deleted"],
  ["source_deleted", "source_deleted"],
] as const;

test("maps every authoritative terminal state exactly for late respond and signal", async () => {
  for (const [state, code] of terminalCases) {
    const notifications: unknown[][] = [];
    const fake = ports(terminalPort(state), (...args) => notifications.push(args));
    for (const result of [
      await respondToSessionRequest(fake, context, { request_id: requestId, answers: [["ok"]] }),
      await signalSessionRequest(fake, context, { request_id: requestId }),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code, retryable: false } });
      if (code === "request_not_pending") {
        expect(result).toMatchObject({ error: { details: { terminal_state: state } } });
      } else if (!result.ok) {
        expect(result.error.details).toBeUndefined();
      }
    }
    expect(notifications).toHaveLength(2);
  }
});

test("maps every cancel winner and treats repeated cancellation as success", async () => {
  for (const [state, code] of terminalCases) {
    const notifications: unknown[][] = [];
    const result = await cancelSessionRequest(
      ports(terminalPort(state), (...args) => notifications.push(args)),
      { ...context, callerSessionId: source },
      { request_id: requestId },
    );
    if (state === "cancelled") {
      expect(result).toEqual({
        ok: true,
        value: { request_id: requestId, state: "cancelled", cancelled_at_ms: 9 },
      });
    } else {
      expect(result).toMatchObject({ ok: false, error: { code } });
    }
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toHaveLength(1);
  }
});

test("maps and notifies every correlated authoritative cancel conflict", async () => {
  for (const [state, code] of terminalCases) {
    const fake = terminalPort("pending");
    fake.cancelPending = async () => ({
      ok: false,
      code: "state_conflict",
      request: metadata(state),
    });
    const notifications: unknown[][] = [];
    const result = await cancelSessionRequest(
      ports(fake, (...args) => notifications.push(args)),
      { ...context, callerSessionId: source },
      { request_id: requestId },
    );
    if (state === "cancelled") {
      expect(result).toEqual({
        ok: true,
        value: { request_id: requestId, state: "cancelled", cancelled_at_ms: 9 },
      });
    } else {
      expect(result).toMatchObject({ ok: false, error: { code } });
    }
    expect(notifications).toHaveLength(1);
  }
});

test("maps pending wrong-kind conflicts without notifying", async () => {
  const notifications: unknown[][] = [];
  const fake = ports(terminalPort("pending"), (...args) => notifications.push(args));
  expect(
    await respondToSessionRequest(fake, context, { request_id: requestId, answers: [["ok"]] }),
  ).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  expect(await signalSessionRequest(fake, context, { request_id: requestId })).toMatchObject({
    ok: false,
    error: { code: "state_conflict" },
  });
  expect(notifications).toEqual([]);
});

test("maps safe returned and thrown store failures with exact retryability", async () => {
  const failures = [
    ["not_found_or_unauthorized", "not_found_or_unauthorized", false],
    ["quota_exceeded", "quota_exceeded", false],
    ["rate_limited", "rate_limited", true],
    ["storage_unavailable", "storage_unavailable", true],
    ["ownership_lost", "ownership_lost", false],
    ["deadlock_detected", "storage_unavailable", true],
    ["state_conflict", "state_conflict", false],
  ] as const;
  for (const [storedCode, code, retryable] of failures) {
    const fake = terminalPort("pending");
    fake.answerAsk = async () => ({ ok: false, code: storedCode }) as never;
    const result = await respondToSessionRequest(ports(fake), context, {
      request_id: requestId,
      answers: [["ok"]],
    });
    expect(result).toMatchObject({ ok: false, error: { code, retryable } });
    expect(JSON.stringify(result)).not.toMatch(/mapping|msg_|ses_source|ses_target|secret|digest/);
  }
  for (const [fault, code] of [
    [new OwnershipLostFault("ownership secret"), "ownership_lost"],
    [new Error("database secret"), "storage_unavailable"],
  ] as const) {
    const fake = terminalPort("pending");
    fake.signalWait = async () => {
      throw fault;
    };
    expect(
      await signalSessionRequest(ports(fake), context, { request_id: requestId }),
    ).toMatchObject({ ok: false, error: { code } });
  }
});

test("notifies only after a resolved commit and observer throws cannot change success", async () => {
  let resolveStore:
    | ((value: Awaited<ReturnType<RequestTerminalPersistencePort["answerAsk"]>>) => void)
    | undefined;
  const storePromise = new Promise<
    Awaited<ReturnType<RequestTerminalPersistencePort["answerAsk"]>>
  >((resolve) => {
    resolveStore = resolve;
  });
  const fake = terminalPort("pending");
  fake.answerAsk = async () => storePromise;
  const notifications: unknown[][] = [];
  const invocation = respondToSessionRequest(
    ports(fake, (...args) => {
      notifications.push(args);
      throw new Error("observer failure");
    }),
    context,
    { request_id: requestId, answers: [["ok"]] },
  );
  await Promise.resolve();
  expect(notifications).toEqual([]);
  resolveStore?.({
    ok: true,
    outcome: "applied",
    request: metadata("answered") as never,
    result: { kind: "ask", answers: [["ok"]] },
  });
  expect(await invocation).toMatchObject({ ok: true });
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.[0]).toEqual({
    requestId,
    kind: "ask",
    resolutionState: "answered",
    resolvedAtMs: 9,
    retainedResult: { kind: "ask", answers: [["ok"]] },
  });

  const failedNotifications: unknown[][] = [];
  const failed = terminalPort("pending");
  failed.answerAsk = async () => ({ ok: false, code: "storage_unavailable" });
  await respondToSessionRequest(
    ports(failed, (...args) => failedNotifications.push(args)),
    context,
    { request_id: requestId, answers: [["ok"]] },
  );
  expect(failedNotifications).toEqual([]);
});

test("acknowledgement never notifies blockers", async () => {
  const acknowledged = acknowledgedMetadata(11) as never;
  const fake = terminalPort("answered");
  fake.acknowledgeResult = async () => ({ ok: true, outcome: "applied", request: acknowledged });
  let notified = false;
  const result = await acknowledgeSessionRequest(
    ports(fake, () => {
      notified = true;
    }),
    { ...context, callerSessionId: source },
    { request_id: requestId },
  );
  expect(result).toMatchObject({ ok: true, value: { acknowledged_at_ms: 11 } });
  expect(notified).toBe(false);
});

test("fails closed for incoherent store projections and catches every mutation store fault", async () => {
  const otherId = validateRequestId(`req_${"1".repeat(32)}`);
  if (!otherId.ok) throw new Error("bad mismatch fixture");
  const mismatch = { ...metadata("answered"), id: otherId.value } as RequestMetadata;
  const mismatched = terminalPort("pending");
  mismatched.answerAsk = async () =>
    ({
      ok: true,
      outcome: "applied",
      request: mismatch,
      result: { kind: "ask", answers: [["ok"]] },
    }) as never;
  mismatched.signalWait = async () =>
    ({
      ok: true,
      outcome: "applied",
      request: { ...mismatch, kind: "wait", resolutionState: "reached" },
      result: { kind: "wait" },
    }) as never;
  mismatched.cancelPending = async () =>
    ({
      ok: true,
      outcome: "idempotent",
      resolutionState: "cancelled",
      request: { ...mismatch, resolutionState: "cancelled" },
    }) as never;
  mismatched.acknowledgeResult = async () =>
    ({
      ok: true,
      outcome: "idempotent",
      request: { ...mismatch, resultState: "acknowledged", acknowledgedAtMs: 12 },
    }) as never;
  const mismatchedPorts = ports(mismatched);
  for (const result of [
    await respondToSessionRequest(mismatchedPorts, context, {
      request_id: requestId,
      answers: [["ok"]],
    }),
    await signalSessionRequest(mismatchedPorts, context, { request_id: requestId }),
    await cancelSessionRequest(
      mismatchedPorts,
      { ...context, callerSessionId: source },
      { request_id: requestId },
    ),
    await acknowledgeSessionRequest(
      mismatchedPorts,
      { ...context, callerSessionId: source },
      { request_id: requestId },
    ),
  ]) {
    expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }

  const hiddenAck = terminalPort("pending");
  hiddenAck.acknowledgeResult = async () => ({
    ok: false,
    code: "not_found_or_unauthorized",
  });
  expect(
    await acknowledgeSessionRequest(
      ports(hiddenAck),
      { ...context, callerSessionId: source },
      { request_id: requestId },
    ),
  ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });

  const returnedFailures = terminalPort("pending");
  returnedFailures.signalWait = async () => ({ ok: false, code: "state_conflict" });
  returnedFailures.cancelPending = async () => ({ ok: false, code: "quota_exceeded" });
  returnedFailures.acknowledgeResult = async () => ({ ok: false, code: "state_conflict" });
  expect(
    await signalSessionRequest(ports(returnedFailures), context, { request_id: requestId }),
  ).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  expect(
    await cancelSessionRequest(
      ports(returnedFailures),
      { ...context, callerSessionId: source },
      { request_id: requestId },
    ),
  ).toMatchObject({ ok: false, error: { code: "quota_exceeded" } });
  expect(
    await acknowledgeSessionRequest(
      ports(returnedFailures),
      { ...context, callerSessionId: source },
      { request_id: requestId },
    ),
  ).toMatchObject({ ok: false, error: { code: "state_conflict" } });

  for (const operation of ["answer", "cancel", "ack"] as const) {
    const throwing = terminalPort("pending");
    const failure = async (): Promise<never> => {
      throw new Error("store secret");
    };
    if (operation === "answer") throwing.answerAsk = failure;
    else if (operation === "cancel") throwing.cancelPending = failure;
    else throwing.acknowledgeResult = failure;
    const throwingPorts = ports(throwing);
    const result =
      operation === "answer"
        ? await respondToSessionRequest(throwingPorts, context, {
            request_id: requestId,
            answers: [["ok"]],
          })
        : operation === "cancel"
          ? await cancelSessionRequest(
              throwingPorts,
              { ...context, callerSessionId: source },
              { request_id: requestId },
            )
          : await acknowledgeSessionRequest(
              throwingPorts,
              { ...context, callerSessionId: source },
              { request_id: requestId },
            );
    expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});
