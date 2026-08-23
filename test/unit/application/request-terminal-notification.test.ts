import { expect, test } from "bun:test";

import type { CommittedRequestTerminalEvent } from "../../../src/application/request-notification-port";
import type { RequestTerminalPersistencePort } from "../../../src/application/request-ports";
import { respondToSessionRequest } from "../../../src/application/respond-to-session-request";
import { signalSessionRequest } from "../../../src/application/signal-session-request";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import type { FencingToken } from "../../../src/domain/ownership";
import type {
  AnsweredAskRequestMetadata,
  RequestMetadata,
} from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("notification");
const request = validateRequestId(`req_${"4".repeat(32)}`);
const native = validateNativeMessageId(`msg_${"5".repeat(32)}`);
const source = validateSessionId("ses_source");
const target = validateSessionId("ses_target");
if (!workspace.ok || !request.ok || !native.ok || !source.ok || !target.ok) {
  throw new Error("bad notification fixture");
}
const workspaceKey = workspace.value;
const requestId = request.value;
const nativeId = native.value;
const sourceId = source.value;
const targetId = target.value;
const answer = { kind: "ask" as const, answers: [["one"]] };
const answerBytes = new TextEncoder().encode(JSON.stringify(answer)).length;

function answered(): AnsweredAskRequestMetadata {
  return {
    id: requestId,
    workspaceKey,
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    nativeMessageId: nativeId,
    kind: "ask",
    resolutionState: "answered",
    deliveryState: "prepared",
    resultState: "available",
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: 8,
    deadlineAtMs: 100,
    resolvedAtMs: 8,
    resultByteLength: answerBytes,
    resultSha256: "a".repeat(64) as Sha256Digest,
    resultAvailableAtMs: 8,
    resultExpiresAtMs: 86_400_008,
  };
}

function ports(
  requests: Partial<RequestTerminalPersistencePort>,
  notifyTerminal: (event: CommittedRequestTerminalEvent) => unknown,
) {
  const hidden = async () => ({ ok: false, code: "not_found_or_unauthorized" as const }) as never;
  return {
    clock: { nowMs: () => 0 },
    digest: { sha256: async () => new Uint8Array(32).fill(0xaa) },
    membership: {
      readCurrentRoots: async () => ({
        sourceTitle: undefined,
        sourceVisible: true,
        targetVisible: false,
      }),
    },
    requests: {
      answerAsk: hidden,
      signalWait: hidden,
      cancelPending: hidden,
      acknowledgeResult: hidden,
      ...requests,
    } satisfies RequestTerminalPersistencePort,
    notifications: { notifyTerminal: notifyTerminal as never },
  };
}

const context = {
  workspaceKey,
  callerSessionId: targetId,
  fencingToken: 4 as FencingToken,
  abort: new AbortController().signal,
  deadlineMs: 100,
};

test("notification is a minimal deeply frozen snapshot and observer mutation cannot alter output", async () => {
  let observed: CommittedRequestTerminalEvent | undefined;
  const result = await respondToSessionRequest(
    ports(
      {
        answerAsk: async () => ({
          ok: true,
          outcome: "applied",
          request: answered(),
          result: answer,
        }),
      },
      (event) => {
        observed = event;
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.isFrozen(event.retainedResult)).toBe(true);
        if (event.retainedResult?.kind === "ask") {
          expect(Object.isFrozen(event.retainedResult.answers)).toBe(true);
          expect(Object.isFrozen(event.retainedResult.answers[0])).toBe(true);
          (event.retainedResult.answers[0] as string[]).push("mutated");
        }
      },
    ),
    context,
    { request_id: requestId, answers: [["one"]] },
  );
  expect(result).toEqual({
    ok: true,
    value: { request_id: requestId, state: "answered", answered_at_ms: 8 },
  });
  expect(observed).toEqual({
    requestId,
    kind: "ask",
    resolutionState: "answered",
    resolvedAtMs: 8,
    retainedResult: answer,
  });
  expect(JSON.stringify(observed)).not.toMatch(
    /workspace|session|native|digest|delivery|admission|payload|resultSha256/,
  );
});

test("a rejected async contract violation is observed without an unhandled rejection", async () => {
  let unhandled = false;
  const listener = (): void => {
    unhandled = true;
  };
  process.on("unhandledRejection", listener);
  try {
    const result = await respondToSessionRequest(
      ports(
        {
          answerAsk: async () => ({
            ok: true,
            outcome: "applied",
            request: answered(),
            result: answer,
          }),
        },
        () => Promise.reject(new Error("observer rejection")),
      ),
      context,
      { request_id: requestId, answers: [["one"]] },
    );
    expect(result).toMatchObject({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(unhandled).toBe(false);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("intrinsic rejection handling ignores overridden native promise catch and then", async () => {
  let unhandled = false;
  const listener = (): void => {
    unhandled = true;
  };
  process.on("unhandledRejection", listener);
  try {
    const rejected = Promise.reject(new Error("already rejected"));
    Object.defineProperties(rejected, {
      catch: {
        configurable: true,
        get: () => {
          throw new Error("overridden catch must not run");
        },
      },
      constructor: {
        configurable: true,
        get: () => {
          throw new Error("overridden constructor must not run");
        },
      },
      // biome-ignore lint/suspicious/noThenProperty: this adversarial native Promise intentionally shadows then.
      then: {
        configurable: true,
        get: () => {
          throw new Error("overridden then must not run");
        },
      },
    });
    const result = await respondToSessionRequest(
      ports(
        {
          answerAsk: async () => ({
            ok: true,
            outcome: "applied",
            request: answered(),
            result: answer,
          }),
        },
        () => rejected,
      ),
      context,
      { request_id: requestId, answers: [["one"]] },
    );
    expect(result).toMatchObject({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(unhandled).toBe(false);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("sync observer throw is isolated and pending, hidden, and store failures never notify", async () => {
  const successful = await respondToSessionRequest(
    ports(
      {
        answerAsk: async () => ({
          ok: true,
          outcome: "applied",
          request: answered(),
          result: answer,
        }),
      },
      () => {
        throw new Error("observer throw");
      },
    ),
    context,
    { request_id: requestId, answers: [["one"]] },
  );
  expect(successful).toMatchObject({ ok: true });

  let notifications = 0;
  const {
    resolvedAtMs: _resolved,
    resultByteLength: _bytes,
    resultSha256: _sha,
    resultAvailableAtMs: _available,
    resultExpiresAtMs: _expires,
    ...requestBase
  } = answered();
  const pending = {
    ...requestBase,
    kind: "wait",
    resolutionState: "pending",
    resultState: "none",
    payloadSha256: "b".repeat(64) as Sha256Digest,
    updatedAtMs: 1,
  } as RequestMetadata;
  for (const failure of [
    { ok: false, code: "state_conflict", request: pending },
    { ok: false, code: "not_found_or_unauthorized" },
    { ok: false, code: "storage_unavailable" },
  ]) {
    const result = await signalSessionRequest(
      ports({ signalWait: async () => failure as never }, () => {
        notifications++;
      }),
      context,
      { request_id: requestId },
    );
    expect(result.ok).toBe(false);
  }
  expect(notifications).toBe(0);
});
