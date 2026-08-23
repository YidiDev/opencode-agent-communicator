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
import type {
  AnsweredAskRequestMetadata,
  ReachedWaitRequestMetadata,
  RequestMetadata,
} from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspaceResult = validateWorkspaceKey("mutations");
const foreignWorkspaceResult = validateWorkspaceKey("foreign");
const requestIdResult = validateRequestId(`req_${"a".repeat(32)}`);
const nativeIdResult = validateNativeMessageId(`msg_${"b".repeat(32)}`);
const sourceResult = validateSessionId("ses_source");
const targetResult = validateSessionId("ses_target");
const unrelatedResult = validateSessionId("ses_unrelated");
if (
  !workspaceResult.ok ||
  !foreignWorkspaceResult.ok ||
  !requestIdResult.ok ||
  !nativeIdResult.ok ||
  !sourceResult.ok ||
  !targetResult.ok ||
  !unrelatedResult.ok
) {
  throw new Error("bad fixture");
}
const workspace = workspaceResult.value;
const foreignWorkspace = foreignWorkspaceResult.value;
const requestId = requestIdResult.value;
const nativeId = nativeIdResult.value;
const source = sourceResult.value;
const target = targetResult.value;
const unrelated = unrelatedResult.value;
const token = 1 as FencingToken;
const digest = "c".repeat(64) as Sha256Digest;

function terminal(
  state: RequestMetadata["resolutionState"],
  options: { readonly kind?: "ask" | "wait"; readonly acknowledgedAtMs?: number } = {},
): RequestMetadata {
  const kind = options.kind ?? (state === "reached" ? "wait" : "ask");
  const resolvedAtMs = state === "deadline_expired" ? 100_000_000 : 20;
  const updatedAtMs = Math.max(resolvedAtMs, options.acknowledgedAtMs ?? 0);
  const base = {
    id: requestId,
    workspaceKey: workspace,
    sourceSessionId: source,
    targetSessionId: target,
    nativeMessageId: nativeId,
    kind,
    deliveryState: "prepared" as const,
    payloadByteLength: 10,
    createdAtMs: 1,
    updatedAtMs,
    deadlineAtMs: 100_000_000,
  };
  if (state === "pending") {
    return {
      ...base,
      resolutionState: "pending",
      resultState: "none",
      payloadSha256: digest,
    } as RequestMetadata;
  }
  if (state === "answered" || state === "reached") {
    const successful = {
      ...base,
      kind: state === "answered" ? ("ask" as const) : ("wait" as const),
      resolutionState: state,
      resolvedAtMs,
      resultAvailableAtMs: resolvedAtMs,
      resultExpiresAtMs: resolvedAtMs + 86_400_000,
    };
    return options.acknowledgedAtMs === undefined
      ? ({
          ...successful,
          resultState: "available",
          resultByteLength: new TextEncoder().encode(
            JSON.stringify(
              state === "answered" ? { kind: "ask", answers: [["yes"]] } : { kind: "wait" },
            ),
          ).length,
          resultSha256: digest,
        } as RequestMetadata)
      : ({
          ...successful,
          resultState: "acknowledged",
          acknowledgedAtMs: options.acknowledgedAtMs,
        } as RequestMetadata);
  }
  return {
    ...base,
    resolutionState: state,
    resolvedAtMs,
    resultState: "none",
  } as RequestMetadata;
}

const answered = terminal("answered") as AnsweredAskRequestMetadata;
const reached = terminal("reached") as ReachedWaitRequestMetadata;
const cancelled = terminal("cancelled");

function requestPort(
  overrides: Partial<RequestTerminalPersistencePort> = {},
): RequestTerminalPersistencePort {
  const hidden = async (): Promise<{
    readonly ok: false;
    readonly code: "not_found_or_unauthorized";
  }> => ({ ok: false, code: "not_found_or_unauthorized" });
  return {
    answerAsk: hidden,
    signalWait: hidden,
    cancelPending: hidden,
    acknowledgeResult: hidden,
    ...overrides,
  };
}

function harness(
  options: {
    readonly requests?: Partial<RequestTerminalPersistencePort>;
    readonly visible?: boolean;
    readonly membershipFault?: unknown;
    readonly notificationThrows?: boolean;
  } = {},
) {
  const effects = {
    membership: 0,
    membershipInputs: [] as unknown[][],
    store: 0,
    notifications: [] as unknown[][],
  };
  const wrap = requestPort(options.requests);
  const requests: RequestTerminalPersistencePort = {
    answerAsk: async (input) => {
      effects.store++;
      return wrap.answerAsk(input);
    },
    signalWait: async (input) => {
      effects.store++;
      return wrap.signalWait(input);
    },
    cancelPending: async (input) => {
      effects.store++;
      return wrap.cancelPending(input);
    },
    acknowledgeResult: async (input) => {
      effects.store++;
      return wrap.acknowledgeResult(input);
    },
  };
  return {
    effects,
    ports: {
      readiness: { assertReady: () => undefined },
      clock: { nowMs: () => 0 },
      digest: { sha256: async () => new Uint8Array(32).fill(0xcc) },
      membership: {
        readCurrentRoots: async (...input: unknown[]) => {
          effects.membership++;
          effects.membershipInputs.push(input);
          if (options.membershipFault) throw options.membershipFault;
          return {
            sourceTitle: undefined,
            sourceVisible: options.visible ?? true,
            targetVisible: false,
          };
        },
      },
      requests,
      notifications: {
        notifyTerminal: (...input: unknown[]): undefined => {
          effects.notifications.push(input);
          if (options.notificationThrows) throw new Error("observer secret");
          return undefined;
        },
      },
    },
  };
}

const context = {
  workspaceKey: workspace,
  callerSessionId: target,
  fencingToken: token,
  abort: new AbortController().signal,
  deadlineMs: 1_000_000_000,
};

test("validates caller, request ID, bounded answers, and bounded evidence before effects", async () => {
  for (const invoke of [
    (mock: ReturnType<typeof harness>) =>
      respondToSessionRequest(
        mock.ports,
        { ...context, callerSessionId: "bad" },
        {
          request_id: requestId,
          answers: [["yes"]],
        },
      ),
    (mock: ReturnType<typeof harness>) =>
      signalSessionRequest(mock.ports, context, { request_id: "bad", evidence: "ok" }),
    (mock: ReturnType<typeof harness>) =>
      respondToSessionRequest(mock.ports, context, { request_id: requestId, answers: "bad" }),
    (mock: ReturnType<typeof harness>) =>
      respondToSessionRequest(mock.ports, context, {
        request_id: requestId,
        answers: [["x".repeat(4_097)]],
      }),
    (mock: ReturnType<typeof harness>) =>
      signalSessionRequest(mock.ports, context, {
        request_id: requestId,
        evidence: "x".repeat(4_097),
      }),
    (mock: ReturnType<typeof harness>) =>
      cancelSessionRequest(
        mock.ports,
        { ...context, callerSessionId: "bad" },
        {
          request_id: requestId,
        },
      ),
    (mock: ReturnType<typeof harness>) =>
      acknowledgeSessionRequest(mock.ports, context, { request_id: "bad" }),
  ]) {
    const mock = harness();
    expect(await invoke(mock)).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(mock.effects).toMatchObject({ membership: 0, store: 0, notifications: [] });
  }
});

test("requires only the caller visible and safely maps membership faults", async () => {
  const invisible = harness({ visible: false });
  expect(
    await signalSessionRequest(invisible.ports, context, { request_id: requestId }),
  ).toMatchObject({ ok: false, error: { code: "caller_not_visible", retryable: false } });
  expect(invisible.effects.store).toBe(0);

  for (const [fault, code] of [
    [new Error("native secret"), "native_unavailable"],
    [new OwnershipLostFault("lease secret"), "ownership_lost"],
  ] as const) {
    const mock = harness({ membershipFault: fault });
    expect(
      await cancelSessionRequest(
        mock.ports,
        { ...context, callerSessionId: source },
        {
          request_id: requestId,
        },
      ),
    ).toMatchObject({ ok: false, error: { code } });
    expect(mock.effects.store).toBe(0);
  }

  let signalInput: unknown;
  const counterpartInvisible = harness({
    requests: {
      signalWait: async (input) => {
        signalInput = input;
        return { ok: true, outcome: "applied", request: reached, result: { kind: "wait" } };
      },
    },
  });
  expect(
    await signalSessionRequest(counterpartInvisible.ports, context, { request_id: requestId }),
  ).toMatchObject({ ok: true });
  expect(counterpartInvisible.effects.membershipInputs).toEqual([[workspace, target, target]]);
  expect(signalInput).toMatchObject({ callerSessionId: target });
});

test("preserves absent versus empty evidence and returns minimal redacted DTOs", async () => {
  const inputs: unknown[] = [];
  const mock = harness({
    requests: {
      answerAsk: async () => ({
        ok: true,
        outcome: "applied",
        request: answered,
        result: { kind: "ask", answers: [["yes"]] },
      }),
      signalWait: async (input) => {
        inputs.push(input);
        const result = Object.hasOwn(input, "evidence")
          ? { kind: "wait" as const, evidence: input.evidence }
          : { kind: "wait" as const };
        return {
          ok: true,
          outcome: "applied",
          request: {
            ...reached,
            resultByteLength: new TextEncoder().encode(JSON.stringify(result)).length,
          },
          result,
        } as never;
      },
    },
  });
  const response = await respondToSessionRequest(mock.ports, context, {
    request_id: requestId,
    answers: [["yes"]],
  });
  const absent = await signalSessionRequest(mock.ports, context, { request_id: requestId });
  const empty = await signalSessionRequest(mock.ports, context, {
    request_id: requestId,
    evidence: "",
  });
  expect(response).toEqual({
    ok: true,
    value: { request_id: requestId, state: "answered", answered_at_ms: 20 },
  });
  expect(absent).toEqual({
    ok: true,
    value: { request_id: requestId, state: "reached", reached_at_ms: 20 },
  });
  expect(empty).toMatchObject({ ok: true });
  expect(inputs[0]).not.toHaveProperty("evidence");
  expect(inputs[1]).toHaveProperty("evidence", "");
  expect(JSON.stringify([response, absent])).not.toMatch(
    /workspace|native|answers|evidence|payload|digest/,
  );
});

test("enforces target/source role and workspace through an exact authorization fake", async () => {
  const authorized = requestPort({
    answerAsk: async (input) =>
      input.workspaceKey === workspace && input.callerSessionId === target
        ? {
            ok: true,
            outcome: "applied",
            request: answered,
            result: { kind: "ask", answers: [["yes"]] },
          }
        : { ok: false, code: "not_found_or_unauthorized" },
    cancelPending: async (input) =>
      input.workspaceKey === workspace && input.callerSessionId === source
        ? {
            ok: true,
            outcome: "idempotent",
            resolutionState: "cancelled",
            request: cancelled as never,
          }
        : { ok: false, code: "not_found_or_unauthorized" },
  });
  for (const callerSessionId of [source, unrelated]) {
    const mock = harness({ requests: authorized });
    expect(
      await respondToSessionRequest(
        mock.ports,
        { ...context, callerSessionId },
        {
          request_id: requestId,
          answers: [["yes"]],
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });
  }
  const foreign = harness({ requests: authorized });
  expect(
    await respondToSessionRequest(
      foreign.ports,
      { ...context, workspaceKey: foreignWorkspace },
      { request_id: requestId, answers: [["yes"]] },
    ),
  ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });
  const sourceMock = harness({ requests: authorized });
  expect(
    await cancelSessionRequest(
      sourceMock.ports,
      { ...context, callerSessionId: source },
      {
        request_id: requestId,
      },
    ),
  ).toMatchObject({ ok: true });
  expect(
    await cancelSessionRequest(sourceMock.ports, context, { request_id: requestId }),
  ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });
});

test("keeps cancellation and acknowledgement timestamps stable across retries", async () => {
  const acknowledged = terminal("answered", { acknowledgedAtMs: 44 }) as never;
  let cancellationCalls = 0;
  let acknowledgementCalls = 0;
  const mock = harness({
    requests: {
      cancelPending: async () => {
        cancellationCalls++;
        return {
          ok: true,
          outcome: cancellationCalls === 1 ? "applied" : "idempotent",
          resolutionState: "cancelled",
          request: cancelled as never,
        };
      },
      acknowledgeResult: async () => {
        acknowledgementCalls++;
        return {
          ok: true,
          outcome: acknowledgementCalls === 1 ? "applied" : "idempotent",
          request: acknowledged,
        };
      },
    },
  });
  for (let count = 0; count < 2; count++) {
    expect(
      await cancelSessionRequest(
        mock.ports,
        { ...context, callerSessionId: source },
        {
          request_id: requestId,
        },
      ),
    ).toMatchObject({ ok: true, value: { cancelled_at_ms: 20 } });
    expect(
      await acknowledgeSessionRequest(
        mock.ports,
        { ...context, callerSessionId: source },
        {
          request_id: requestId,
        },
      ),
    ).toMatchObject({ ok: true, value: { acknowledged_at_ms: 44 } });
  }
  expect(mock.effects.notifications).toHaveLength(2);
});

test("every operation uses caller-only membership and returns the exact hidden response", async () => {
  const expected = {
    ok: false,
    error: {
      code: "not_found_or_unauthorized",
      message: "Request was not found or the caller is not authorized.",
      retryable: false,
    },
  } as const;
  const operations = [
    {
      caller: target,
      invoke: (mock: ReturnType<typeof harness>) =>
        respondToSessionRequest(mock.ports, context, { request_id: requestId, answers: [[]] }),
    },
    {
      caller: target,
      invoke: (mock: ReturnType<typeof harness>) =>
        signalSessionRequest(mock.ports, context, { request_id: requestId }),
    },
    {
      caller: source,
      invoke: (mock: ReturnType<typeof harness>) =>
        cancelSessionRequest(
          mock.ports,
          { ...context, callerSessionId: source },
          { request_id: requestId },
        ),
    },
    {
      caller: source,
      invoke: (mock: ReturnType<typeof harness>) =>
        acknowledgeSessionRequest(
          mock.ports,
          { ...context, callerSessionId: source },
          { request_id: requestId },
        ),
    },
  ];
  for (const operation of operations) {
    const mock = harness();
    expect(await operation.invoke(mock)).toEqual(expected);
    expect(mock.effects.membershipInputs).toEqual([
      [workspace, operation.caller, operation.caller],
    ]);
    expect(mock.effects.notifications).toEqual([]);
  }
});
