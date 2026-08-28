import { expect, test } from "bun:test";

import {
  settleAdmissionCleanup,
  settleAdmissionForeground,
  wakeAfterRequestAdmission,
} from "../../../src/application/blocking-request-admission-settlement";
import {
  currentRequestOwnership,
  observeActiveRequestParticipants,
  proveCurrentCallerVisibility,
} from "../../../src/application/blocking-request-creation-preconditions";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import type { SessionSendPorts } from "../../../src/application/session-message-delivery-contracts";
import { readSessionSendMembership } from "../../../src/application/session-message-membership";
import type { FencingToken } from "../../../src/domain/ownership";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function blockingBoundaryFixture() {
  const request = (await requestFixture(token)).request;
  const abort = new AbortController();
  const effect = new AbortController();
  const context: SessionBlockingRequestContext = {
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    fencingToken: token,
    abort: abort.signal,
    deadlineMs: request.deadlineAtMs,
  };
  const ports = {
    ownership: { isCurrent: async () => true },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "busy" as const,
      }),
    },
    clock: { nowMs: () => request.createdAtMs },
    runtime: {
      effectSignal: effect.signal,
      wakeRequest: () => undefined,
    },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
    scheduler: { wake: () => undefined },
  } as unknown as SessionBlockingRequestPorts;
  return { abort, context, effect, ports, request };
}

test("request-refactor ownership and participant reads stop at both cancellation checkpoints", async () => {
  const ownership = await blockingBoundaryFixture();
  ownership.ports.ownership.isCurrent = () => {
    ownership.abort.abort("ownership read interrupted");
    return new Promise<boolean>(() => undefined);
  };
  expect(await currentRequestOwnership(ownership.ports, ownership.context)).toMatchObject({
    ok: false,
    error: { code: "request_cancelled" },
  });

  const participants = await blockingBoundaryFixture();
  participants.abort.abort("cancelled before activity");
  expect(
    await observeActiveRequestParticipants(
      participants.ports,
      participants.context,
      participants.request.targetSessionId,
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });

  const membership = await blockingBoundaryFixture();
  const syntheticAbort = {
    aborted: false,
    reason: undefined,
    onabort: null,
    throwIfAborted: () => undefined,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") listener(new Event("abort"));
      else listener.handleEvent(new Event("abort"));
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  } as AbortSignal;
  Object.assign(membership.ports, {
    membership: { readCurrentRoots: () => new Promise<never>(() => undefined) },
  });
  expect(
    await proveCurrentCallerVisibility(membership.ports, {
      ...membership.context,
      abort: syntheticAbort,
    }),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
});

test("request-refactor admission settlement covers pre-abort, deadline, and cleanup faults", async () => {
  const preAborted = await blockingBoundaryFixture();
  preAborted.abort.abort("already cancelled");
  expect(
    await settleAdmissionForeground(preAborted.ports, preAborted.context, async () => "unused"),
  ).toEqual({ kind: "aborted" });

  const deadline = await blockingBoundaryFixture();
  deadline.ports.deadlineTimer.arm = (_delay, wake) => {
    queueMicrotask(wake);
    return { cancel: () => undefined };
  };
  expect(
    await settleAdmissionForeground(
      deadline.ports,
      deadline.context,
      () => new Promise<never>(() => undefined),
    ),
  ).toEqual({ kind: "aborted" });

  const cleanup = await blockingBoundaryFixture();
  const timerFault = new Error("cleanup timer unavailable");
  cleanup.ports.deadlineTimer.arm = () => {
    throw timerFault;
  };
  expect(await settleAdmissionCleanup(cleanup.ports, async () => "unused")).toEqual({
    kind: "rejected",
    cause: timerFault,
  });
});

test("request-refactor admission wake observes promise returns and always wakes the request", async () => {
  const setup = await blockingBoundaryFixture();
  const wakeIds: string[] = [];
  setup.ports.scheduler.wake = (() =>
    Promise.reject(new Error("background scheduler fault"))) as never;
  setup.ports.runtime.wakeRequest = (requestId) => wakeIds.push(requestId);
  wakeAfterRequestAdmission(setup.ports, setup.request);
  await Promise.resolve();
  expect(wakeIds).toEqual([setup.request.id]);
});

test("request-refactor membership rejects malformed bounded and unbounded snapshots", async () => {
  const request = (await requestFixture(token)).request;
  const ports = {
    membership: { readCurrentRoots: async () => ({ malformed: true }) },
  } as unknown as SessionSendPorts;
  const context = {
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    abort: new AbortController().signal,
  };
  expect(await readSessionSendMembership(ports, context, request.targetSessionId)).toMatchObject({
    ok: false,
    error: { code: "native_unavailable" },
  });
  expect(
    await readSessionSendMembership(
      ports,
      { ...context, deadlineMs: Date.now() + 1_000 },
      request.targetSessionId,
    ),
  ).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
});
