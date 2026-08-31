import { afterEach, expect, test } from "bun:test";

import type {
  PrepareRequestInput,
  RequestStoreResult,
} from "../../../src/application/request-ports";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { waitSession } from "../../../src/application/wait-session";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import {
  deferred,
  blockingRequestFixture as fixture,
} from "../../support/blocking-request-fixture";
import { cleanupRequestStoreRoots, requestTestWorkspace } from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

type Setup = Awaited<ReturnType<typeof fixture>>;

async function waitForCreatedRequest(setup: Setup) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const outbox = await setup.store.listForParticipant({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.source,
      role: "outbox",
      limit: 1,
    });
    const request = outbox.items[0];
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error("The blocking request was not durably created.");
}

test("blocking wait observes context admission without awaiting obsolete native steer", async () => {
  const nativeNeverSettles = deferred<never>();
  const setup = await fixture(() => nativeNeverSettles.promise);
  const abort = new AbortController();
  const blocked = waitSession(
    setup.ports,
    { ...setup.context, abort: abort.signal },
    { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
  );

  expect(await waitForCreatedRequest(setup)).toMatchObject({
    deliveryMode: "context",
    deliveryState: "context_admitted",
  });
  abort.abort("test_cleanup");

  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test("the invocation deadline cancels a context-admitted blocking request", async () => {
  const setup = await fixture(async () => ({ kind: "unknown" }));
  const invocationDeadline = deferred<() => void>();
  const blocked = waitSession(
    {
      ...setup.ports,
      deadlineTimer: {
        arm: (delayMs, wake) => {
          if (delayMs === setup.context.deadlineMs - 25_000) invocationDeadline.resolve(wake);
          return { cancel: () => undefined };
        },
      },
    },
    setup.context,
    { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
  );
  const request = await waitForCreatedRequest(setup);
  expect(request).toMatchObject({ deliveryState: "context_admitted" });

  (await invocationDeadline.promise)();

  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  expect(
    await setup.store.getRequestMetadata({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      requestId: request.requestId,
    }),
  ).toMatchObject({ resolutionState: "cancelled", deliveryState: "context_admitted" });
  setup.store.close();
});

test("a cancel commit with lost settlement uses a fresh bounded authoritative read", async () => {
  const setup = await fixture(async () => ({ kind: "unknown" }));
  const requests = Object.create(setup.ports.requests) as typeof setup.store;
  const cancelCommitted = deferred<void>();
  requests.cancelPending = async (input) => {
    await setup.store.cancelPending(input);
    cancelCommitted.resolve();
    return new Promise(() => undefined);
  };
  const cleanupDeadlines: Array<{ wake(): void; cancelled: boolean }> = [];
  const abort = new AbortController();
  const blocked = waitSession(
    {
      ...setup.ports,
      requests,
      deadlineTimer: {
        arm: (delayMs, wake) => {
          const cleanup = { wake, cancelled: false };
          if (delayMs === 1_000) cleanupDeadlines.push(cleanup);
          return { cancel: () => (cleanup.cancelled = true) };
        },
      },
    },
    { ...setup.context, abort: abort.signal },
    { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
  );
  expect(await waitForCreatedRequest(setup)).toMatchObject({ deliveryState: "context_admitted" });
  abort.abort("caller_cancelled");
  await cancelCommitted.promise;
  const activeCancellationDeadlines = cleanupDeadlines.filter((phase) => !phase.cancelled);
  expect(activeCancellationDeadlines).toHaveLength(1);
  const phasesBeforeCancellationTimeout = cleanupDeadlines.length;
  activeCancellationDeadlines[0]?.wake();

  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  expect(cleanupDeadlines.length).toBeGreaterThan(phasesBeforeCancellationTimeout);
  setup.store.close();
});

test("a failed context admission remains durably terminal and fail-closed", async () => {
  const setup = await fixture(async () => {
    throw new Error("native steer is not part of context admission");
  });
  const requests = Object.create(setup.store) as typeof setup.store;
  const requestCreates = requests as unknown as {
    createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  };
  requestCreates.createPrepared = async (input) => {
    const created = await setup.store.createPrepared(input);
    if (!created.ok) return created;
    await setup.store.failUncertainContextOnStartup({
      fencingToken: input.fencingToken,
      workspaceKey: input.request.workspaceKey,
      limit: 1,
    });
    return created;
  };

  expect(
    await waitSession({ ...setup.ports, requests }, setup.context, {
      session_id: setup.target,
      milestone: "ready",
      timeout_seconds: 30,
    }),
  ).toMatchObject({ ok: false, error: { code: "delivery_failed" } });
  expect(await waitForCreatedRequest(setup)).toMatchObject({
    resolutionState: "delivery_failed",
    deliveryState: "delivery_failed",
  });
  setup.store.close();
});

test.each([
  "throws",
  "malformed",
  "extra",
  "ownership_lost",
  "quota_exceeded",
  "rate_limited",
] as const)("fails safely when context request creation returns %s", async (mode) => {
  const setup = await fixture(async () => {
    throw new Error("native steer must not run");
  });
  const requests = Object.create(setup.store) as typeof setup.store;
  const requestCreates = requests as unknown as {
    createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  };
  requestCreates.createPrepared = async () => {
    if (mode === "throws") throw new Error("private");
    if (mode === "ownership_lost") throw new OwnershipLostFault("stale");
    if (mode === "malformed") return { ok: true } as never;
    if (mode === "extra") return { ok: false, code: "quota_exceeded", extra: true } as never;
    return { ok: false, code: mode };
  };

  expect(
    await waitSession({ ...setup.ports, requests }, setup.context, {
      session_id: setup.target,
      milestone: "ready",
      timeout_seconds: 30,
    }),
  ).toMatchObject({
    ok: false,
    error: {
      code:
        mode === "ownership_lost"
          ? "ownership_lost"
          : mode === "quota_exceeded" || mode === "rate_limited"
            ? mode
            : "storage_unavailable",
    },
  });
  setup.store.close();
});

test("a throwing scheduler wake cannot reverse a context-admitted cancellation", async () => {
  const setup = await fixture(async () => ({ kind: "unknown" }));
  const abort = new AbortController();
  const requests = Object.create(setup.ports.requests) as typeof setup.store;
  const requestCreates = requests as unknown as {
    createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  };
  requestCreates.createPrepared = async (input) => {
    const created = await setup.ports.requests.createPrepared(input);
    queueMicrotask(() => abort.abort("test_cleanup"));
    return created;
  };
  const scheduler = {
    wake: () => {
      throw new Error("wake fault");
    },
  };

  expect(
    await waitSession(
      { ...setup.ports, requests, scheduler },
      { ...setup.context, abort: abort.signal },
      { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test("handles unsafe deadlines and process-local waiter capacity before persistence", async () => {
  const unsafe = await fixture(async () => ({ kind: "unknown" }));
  expect(
    await waitSession(
      { ...unsafe.ports, clock: { nowMs: () => Number.MAX_SAFE_INTEGER - 100 } },
      { ...unsafe.context, deadlineMs: Number.MAX_SAFE_INTEGER },
      { session_id: unsafe.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  unsafe.store.close();

  const capacity = await fixture(async () => ({ kind: "unknown" }));
  const runtime = new RequestRuntime(1);
  runtime.attach({
    requestId: `req_${"01".repeat(16)}` as never,
    expectedKind: "wait",
    sourceSessionId: capacity.source,
    workspaceKey: requestTestWorkspace(),
  });
  expect(
    await waitSession({ ...capacity.ports, runtime, notifications: runtime }, capacity.context, {
      session_id: capacity.target,
      milestone: "ready",
      timeout_seconds: 30,
    }),
  ).toMatchObject({ ok: false, error: { code: "quota_exceeded" } });
  capacity.store.close();
});

test("a context cancellation committed during create is reported without a native claim", async () => {
  const setup = await fixture(async () => {
    throw new Error("must not steer");
  });
  const requests = Object.create(setup.store) as typeof setup.store;
  const requestCreates = requests as unknown as {
    createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  };
  requestCreates.createPrepared = async (input) => {
    const created = await setup.store.createPrepared(input);
    if (!created.ok) return created;
    await setup.store.cancelContextAdmission({
      fencingToken: input.fencingToken,
      workspaceKey: input.request.workspaceKey,
      id: input.request.id,
    });
    return created;
  };

  expect(
    await waitSession({ ...setup.ports, requests }, setup.context, {
      session_id: setup.target,
      milestone: "ready",
      timeout_seconds: 30,
    }),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});
