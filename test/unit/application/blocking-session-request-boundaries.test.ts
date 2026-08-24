import { expect, test } from "bun:test";

import { claimAndAdmitBlockingRequest } from "../../../src/application/blocking-session-request-admission";
import {
  blockingCheckpoint,
  type SessionBlockingRequestPorts,
  validateBlockingInput,
  validateGeneratedRequestIds,
} from "../../../src/application/blocking-session-request-boundaries";
import { RequestRuntime } from "../../../src/application/request-runtime";
import type { FencingToken } from "../../../src/domain/ownership";
import { requestFixture, requestSession, requestTestWorkspace } from "../../support/request-store";

const source = requestSession("ses_source");
const target = requestSession("ses_target");
const context = {
  workspaceKey: requestTestWorkspace(),
  sourceSessionId: source,
  fencingToken: 1 as FencingToken,
  abort: new AbortController().signal,
  deadlineMs: 100,
};

test("blocking checkpoints fail closed for abort, clock, and invocation deadline boundaries", () => {
  const aborted = new AbortController();
  aborted.abort();
  expect(
    blockingCheckpoint({ nowMs: () => 1 }, { abort: aborted.signal, deadlineMs: 100 }),
  ).toMatchObject({
    ok: false,
    error: { code: "request_cancelled" },
  });
  expect(blockingCheckpoint({ nowMs: () => Number.NaN }, context)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
  expect(
    blockingCheckpoint(
      {
        nowMs: () => {
          throw new Error("clock fault");
        },
      },
      context,
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  expect(blockingCheckpoint({ nowMs: () => 100 }, context)).toMatchObject({
    ok: false,
    error: { code: "request_cancelled" },
  });
  expect(blockingCheckpoint({ nowMs: () => 99 }, context)).toEqual({ ok: true, value: 99 });
  const raced = new AbortController();
  expect(
    blockingCheckpoint(
      {
        nowMs: () => {
          raced.abort();
          return 1;
        },
      },
      { abort: raced.signal, deadlineMs: 100 },
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
});

test.each([
  ["ask", undefined],
  ["ask", { session_id: target, questions: [], timeout_seconds: 30, extra: true }],
  ["ask", { session_id: target, questions: {}, timeout_seconds: 30 }],
  ["ask", { session_id: target, questions: [{}], timeout_seconds: 30 }],
  ["ask", { session_id: target, questions: [{ prompt: "?", options: {} }], timeout_seconds: 30 }],
  ["ask", { session_id: target, questions: [{ prompt: "", options: [] }], timeout_seconds: 30 }],
  [
    "ask",
    {
      session_id: target,
      questions: [{ prompt: "?", options: ["yes"], multiple: null }],
      timeout_seconds: 30,
    },
  ],
  [
    "ask",
    {
      session_id: target,
      questions: [{ prompt: "?", options: ["yes"], allow_custom: null }],
      timeout_seconds: 30,
    },
  ],
  [
    "ask",
    {
      session_id: target,
      questions: [{ prompt: "?", options: ["yes"], multiple: undefined }],
      timeout_seconds: 30,
    },
  ],
  ["wait", { session_id: target, milestone: "", timeout_seconds: 30 }],
] as const)("strictly rejects malformed public payload %#", (operation, args) => {
  expect(validateBlockingInput(operation, context, args).ok).toBe(false);
});

test("validates context identities, deadlock, defaults, and generated IDs", () => {
  const ask = validateBlockingInput("ask", context, {
    session_id: target,
    questions: [{ prompt: "Ready?", options: [], allow_custom: true }],
    timeout_seconds: 30,
  });
  expect(ask).toMatchObject({
    ok: true,
    value: { payload: { questions: [{ multiple: false, allowCustom: true }] } },
  });
  expect(
    validateBlockingInput(
      "wait",
      { ...context, sourceSessionId: "bad" as never },
      {
        session_id: target,
        milestone: "ready",
        timeout_seconds: 30,
      },
    ).ok,
  ).toBe(false);
  expect(
    validateBlockingInput("wait", context, {
      session_id: source,
      milestone: "ready",
      timeout_seconds: 30,
    }),
  ).toMatchObject({ ok: false, error: { code: "deadlock_detected" } });
  const operationId = `op_${"c".repeat(32)}`;
  expect(
    validateGeneratedRequestIds(`req_${"a".repeat(32)}`, `msg_${"b".repeat(32)}`, operationId),
  ).toBe(true);
  expect(validateGeneratedRequestIds("bad", `msg_${"b".repeat(32)}`, operationId)).toBe(false);
  expect(validateGeneratedRequestIds(`req_${"a".repeat(32)}`, "bad", operationId)).toBe(false);
});

test.each([true, false])(
  "unresolved submitting cleanup faults only a current fencing token: %s",
  async (isCurrent) => {
    const token = 1 as FencingToken;
    const prepared = (await requestFixture(token)).request;
    const claimed = {
      ...prepared,
      deliveryState: "submitting" as const,
      submittedAtMs: prepared.createdAtMs + 1,
      updatedAtMs: prepared.createdAtMs + 1,
    };
    let arms = 0;
    let faults = 0;
    const runtime = new RequestRuntime();
    const ports = {
      requests: {
        claimPrepared: async () => {
          throw new Error("ambiguous claim");
        },
        reconcilePreparedClaim: async () => ({
          outcome: "current_claim" as const,
          request: claimed,
          envelopeJson: "{}",
        }),
        completeDelivery: async () => new Promise(() => undefined),
      },
      ownership: { isCurrent: async () => isCurrent },
      workflowFault: {
        fault: () => {
          faults += 1;
        },
      },
      deadlineTimer: {
        arm: (_delay: number, wake: () => void) => {
          arms += 1;
          if (arms === 2 || arms === 3) wake();
          return { cancel: () => undefined };
        },
      },
      clock: { nowMs: () => prepared.createdAtMs },
      scheduler: { wake: () => undefined },
      runtime,
      notifications: runtime,
    } as unknown as SessionBlockingRequestPorts;
    expect(
      await claimAndAdmitBlockingRequest(
        ports,
        {
          workspaceKey: prepared.workspaceKey,
          sourceSessionId: prepared.sourceSessionId,
          fencingToken: token,
          abort: new AbortController().signal,
          deadlineMs: prepared.deadlineAtMs,
        },
        prepared,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(faults).toBe(isCurrent ? 1 : 0);
  },
);
