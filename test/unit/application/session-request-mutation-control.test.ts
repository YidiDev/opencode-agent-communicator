import { expect, test } from "bun:test";

import { acknowledgeSessionRequest } from "../../../src/application/acknowledge-session-request";
import { cancelSessionRequest } from "../../../src/application/cancel-session-request";
import type { RequestTerminalPersistencePort } from "../../../src/application/request-ports";
import {
  RequestMutationControlFault,
  type SessionRequestMutationContext,
} from "../../../src/application/request-terminal-use-case";
import { respondToSessionRequest } from "../../../src/application/respond-to-session-request";
import { signalSessionRequest } from "../../../src/application/signal-session-request";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("control");
const request = validateRequestId(`req_${"2".repeat(32)}`);
const native = validateNativeMessageId(`msg_${"3".repeat(32)}`);
const source = validateSessionId("ses_source");
const target = validateSessionId("ses_target");
if (!workspace.ok || !request.ok || !native.ok || !source.ok || !target.ok) {
  throw new Error("bad control fixture");
}
const workspaceKey = workspace.value;
const requestId = request.value;
const nativeId = native.value;
const sourceId = source.value;
const targetId = target.value;
const token = 3 as FencingToken;

function cancelled(): RequestMetadata {
  return {
    id: requestId,
    workspaceKey,
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    nativeMessageId: nativeId,
    kind: "ask",
    resolutionState: "cancelled",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: 5,
    deadlineAtMs: 100,
    resolvedAtMs: 5,
  };
}

function requestPort(overrides: Partial<RequestTerminalPersistencePort> = {}) {
  const hidden = async () => ({ ok: false, code: "not_found_or_unauthorized" as const }) as never;
  return {
    answerAsk: hidden,
    signalWait: hidden,
    cancelPending: hidden,
    acknowledgeResult: hidden,
    ...overrides,
  } satisfies RequestTerminalPersistencePort;
}

function context(abort = new AbortController().signal): SessionRequestMutationContext {
  return {
    workspaceKey,
    callerSessionId: targetId,
    fencingToken: token,
    abort,
    deadlineMs: 100,
  };
}

function ports(options: {
  readonly requests?: Partial<RequestTerminalPersistencePort>;
  readonly membership?: () => Promise<unknown>;
  readonly now?: () => number;
}) {
  let membershipCalls = 0;
  let storeCalls = 0;
  const wrapped = requestPort(options.requests);
  const requests: RequestTerminalPersistencePort = {
    answerAsk: async (input) => {
      storeCalls++;
      return wrapped.answerAsk(input);
    },
    signalWait: async (input) => {
      storeCalls++;
      return wrapped.signalWait(input);
    },
    cancelPending: async (input) => {
      storeCalls++;
      return wrapped.cancelPending(input);
    },
    acknowledgeResult: async (input) => {
      storeCalls++;
      return wrapped.acknowledgeResult(input);
    },
  };
  return {
    counts: {
      get membership() {
        return membershipCalls;
      },
      get store() {
        return storeCalls;
      },
    },
    value: {
      clock: { nowMs: options.now ?? (() => 0) },
      digest: { sha256: async () => new Uint8Array(32) },
      membership: {
        readCurrentRoots: async () => {
          membershipCalls++;
          return (await (
            options.membership ??
            (async () => ({ sourceTitle: undefined, sourceVisible: true, targetVisible: false }))
          )()) as never;
        },
      },
      requests,
      notifications: { notifyTerminal: () => undefined },
    },
  };
}

test("rejects invalid, elapsed, and aborted control before membership for every operation", async () => {
  const controller = new AbortController();
  controller.abort();
  const controls = [
    { ...context(), deadlineMs: Number.NaN },
    { ...context(), deadlineMs: Number.POSITIVE_INFINITY },
    { ...context(), deadlineMs: -1 },
    { ...context(), deadlineMs: 0 },
    context(controller.signal),
  ];
  for (const control of controls) {
    const mock = ports({});
    const invocations = [
      () => respondToSessionRequest(mock.value, control, { request_id: requestId, answers: [[]] }),
      () => signalSessionRequest(mock.value, control, { request_id: requestId }),
      () =>
        cancelSessionRequest(
          mock.value,
          { ...control, callerSessionId: sourceId },
          {
            request_id: requestId,
          },
        ),
      () =>
        acknowledgeSessionRequest(
          mock.value,
          { ...control, callerSessionId: sourceId },
          {
            request_id: requestId,
          },
        ),
    ];
    for (const invoke of invocations) {
      await expect(invoke()).rejects.toBeInstanceOf(RequestMutationControlFault);
    }
    expect(mock.counts).toMatchObject({ membership: 0, store: 0 });
  }
});

test("input validation remains ahead of operation control", async () => {
  const mock = ports({});
  const result = await respondToSessionRequest(
    mock.value,
    { ...context(), deadlineMs: Number.NaN },
    { request_id: "bad", answers: "bad" },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  expect(mock.counts).toMatchObject({ membership: 0, store: 0 });
});

test("invalid or throwing clocks and reentrant abort stop before membership", async () => {
  const invalidClocks: readonly (() => number)[] = [
    () => Number.NaN,
    () => Number.NEGATIVE_INFINITY,
    () => Number.POSITIVE_INFINITY,
    () => -1,
    () => 0.5,
    () => Number.MAX_SAFE_INTEGER + 1,
    () => {
      throw new Error("private clock failure");
    },
  ];
  for (const now of invalidClocks) {
    const mock = ports({ now });
    await expect(
      signalSessionRequest(mock.value, context(), { request_id: requestId }),
    ).rejects.toMatchObject({
      name: "RequestMutationControlFault",
      reason: "invalid_clock",
      message: "Request operation clock is invalid.",
    });
    expect(mock.counts).toMatchObject({ membership: 0, store: 0 });
  }

  const controller = new AbortController();
  const reentrant = ports({
    now: () => {
      controller.abort();
      return 0;
    },
  });
  await expect(
    signalSessionRequest(reentrant.value, context(controller.signal), { request_id: requestId }),
  ).rejects.toMatchObject({ reason: "aborted" });
  expect(reentrant.counts).toMatchObject({ membership: 0, store: 0 });
});

test("late membership completion cannot dispatch store after abort or deadline", async () => {
  for (const stop of ["abort", "deadline"] as const) {
    let markMembershipStarted: (() => void) | undefined;
    const membershipStarted = new Promise<void>((resolve) => {
      markMembershipStarted = resolve;
    });
    let release:
      | ((value: { sourceTitle: undefined; sourceVisible: true; targetVisible: false }) => void)
      | undefined;
    const membership = new Promise<{
      sourceTitle: undefined;
      sourceVisible: true;
      targetVisible: false;
    }>((resolve) => {
      release = resolve;
    });
    let now = 0;
    const controller = new AbortController();
    const mock = ports({
      membership: async () => {
        markMembershipStarted?.();
        return membership;
      },
      now: () => now,
    });
    const invocation = respondToSessionRequest(mock.value, context(controller.signal), {
      request_id: requestId,
      answers: [[]],
    });
    await membershipStarted;
    if (stop === "abort") controller.abort();
    else now = 100;
    release?.({ sourceTitle: undefined, sourceVisible: true, targetVisible: false });
    await expect(invocation).rejects.toMatchObject({
      reason: stop === "abort" ? "aborted" : "deadline_exceeded",
    });
    expect(mock.counts.membership).toBe(1);
    expect(mock.counts.store).toBe(0);
  }
});

test("malformed membership values and throwing getters fail closed before store dispatch", async () => {
  const throwing = {
    sourceTitle: undefined,
    get sourceVisible(): boolean {
      throw new Error("private getter failure");
    },
    targetVisible: false,
  };
  for (const membership of [
    null,
    "visible",
    { sourceTitle: undefined, sourceVisible: 1, targetVisible: false },
    { sourceTitle: undefined, sourceVisible: true, targetVisible: false, extra: true },
    throwing,
  ]) {
    const mock = ports({ membership: async () => membership });
    const result = await cancelSessionRequest(
      mock.value,
      { ...context(), callerSessionId: sourceId },
      { request_id: requestId },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "native_unavailable",
        message: "Current session membership is unavailable.",
        retryable: true,
      },
    });
    expect(mock.counts.membership).toBe(1);
    expect(mock.counts.store).toBe(0);
  }
});

test("every operation performs a final control check immediately before store dispatch", async () => {
  for (const [operation, abortOnRead] of [
    ["respond", 6],
    ["signal", 6],
    ["cancel", 4],
    ["ack", 4],
  ] as const) {
    const controller = new AbortController();
    let reads = 0;
    const mock = ports({
      now: () => {
        reads++;
        if (reads === abortOnRead) controller.abort();
        return 0;
      },
    });
    const control = context(controller.signal);
    const invocation =
      operation === "respond"
        ? respondToSessionRequest(mock.value, control, { request_id: requestId, answers: [[]] })
        : operation === "signal"
          ? signalSessionRequest(mock.value, control, { request_id: requestId })
          : operation === "cancel"
            ? cancelSessionRequest(
                mock.value,
                { ...control, callerSessionId: sourceId },
                { request_id: requestId },
              )
            : acknowledgeSessionRequest(
                mock.value,
                { ...control, callerSessionId: sourceId },
                { request_id: requestId },
              );
    await expect(invocation).rejects.toMatchObject({ reason: "aborted" });
    expect(reads).toBe(abortOnRead);
    expect(mock.counts.membership).toBe(1);
    expect(mock.counts.store).toBe(0);
  }
});

test("abort after persistence dispatch cannot replace the authoritative store result", async () => {
  let release: ((value: never) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const committed = new Promise<never>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const mock = ports({
    requests: {
      cancelPending: async () => {
        markStarted?.();
        return committed;
      },
    },
  });
  const invocation = cancelSessionRequest(
    mock.value,
    { ...context(controller.signal), callerSessionId: sourceId },
    { request_id: requestId },
  );
  await started;
  expect(mock.counts.store).toBe(1);
  controller.abort();
  release?.({
    ok: true,
    outcome: "applied",
    resolutionState: "cancelled",
    request: cancelled(),
  } as never);
  expect(await invocation).toEqual({
    ok: true,
    value: { request_id: requestId, state: "cancelled", cancelled_at_ms: 5 },
  });
});
