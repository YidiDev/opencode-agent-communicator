import { expect, test } from "bun:test";

import type { RequestTerminalPersistencePort } from "../../../src/application/request-ports";
import { RequestMutationControlFault } from "../../../src/application/request-terminal-use-case";
import { respondToSessionRequest } from "../../../src/application/respond-to-session-request";
import { signalSessionRequest } from "../../../src/application/signal-session-request";
import { validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("digest-control");
const request = validateRequestId(`req_${"9".repeat(32)}`);
const caller = validateSessionId("ses_target");
if (!workspace.ok || !request.ok || !caller.ok) throw new Error("bad digest fixture");
const workspaceKey = workspace.value;
const requestId = request.value;
const callerId = caller.value;

function harness(options: {
  readonly digest: (input: Uint8Array) => Promise<Uint8Array>;
  readonly now?: () => number;
}) {
  const counts = { digest: 0, membership: 0, store: 0 };
  const hidden = async () => {
    counts.store++;
    return { ok: false, code: "not_found_or_unauthorized" as const } as never;
  };
  const requests: RequestTerminalPersistencePort = {
    answerAsk: hidden,
    signalWait: hidden,
    cancelPending: hidden,
    acknowledgeResult: hidden,
  };
  return {
    counts,
    ports: {
      readiness: { assertReady: () => undefined },
      clock: { nowMs: options.now ?? (() => 0) },
      digest: {
        sha256: async (input: Uint8Array) => {
          counts.digest++;
          return options.digest(input);
        },
      },
      membership: {
        readCurrentRoots: async () => {
          counts.membership++;
          return { sourceTitle: undefined, sourceVisible: true, targetVisible: false };
        },
      },
      requests,
      notifications: { notifyTerminal: () => undefined },
    },
  };
}

function context(abort = new AbortController().signal) {
  return {
    workspaceKey,
    callerSessionId: callerId,
    fencingToken: 6 as FencingToken,
    abort,
    deadlineMs: 100,
  };
}

test("digest rejection and malformed digest fail safely before membership or store", async () => {
  for (const digest of [
    async (): Promise<Uint8Array> => {
      throw new Error("private hash failure");
    },
    async () => new Uint8Array(31),
  ]) {
    const mock = harness({ digest });
    expect(
      await respondToSessionRequest(mock.ports, context(), {
        request_id: requestId,
        answers: [["answer"]],
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "storage_unavailable",
        message: "Request storage is unavailable.",
        retryable: true,
      },
    });
    expect(mock.counts).toEqual({ digest: 1, membership: 0, store: 0 });
  }
});

test("abort and deadline are rechecked after an asynchronous digest", async () => {
  for (const stop of ["abort", "deadline"] as const) {
    let release: ((value: Uint8Array) => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<Uint8Array>((resolve) => {
      release = resolve;
    });
    let now = 0;
    const controller = new AbortController();
    const mock = harness({
      digest: async () => {
        started?.();
        return pending;
      },
      now: () => now,
    });
    const invocation = signalSessionRequest(mock.ports, context(controller.signal), {
      request_id: requestId,
      evidence: "done",
    });
    await began;
    if (stop === "abort") controller.abort();
    else now = 100;
    release?.(new Uint8Array(32));
    await expect(invocation).rejects.toMatchObject({
      name: "RequestMutationControlFault",
      reason: stop === "abort" ? "aborted" : "deadline_exceeded",
    });
    expect(mock.counts).toEqual({ digest: 1, membership: 0, store: 0 });
  }
});

test("pre-aborted control prevents digest invocation", async () => {
  const controller = new AbortController();
  controller.abort();
  const mock = harness({ digest: async () => new Uint8Array(32) });
  await expect(
    signalSessionRequest(mock.ports, context(controller.signal), { request_id: requestId }),
  ).rejects.toBeInstanceOf(RequestMutationControlFault);
  expect(mock.counts).toEqual({ digest: 0, membership: 0, store: 0 });
});
