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

test("an aborted unsettled queue admission fails closed after durable creation", async () => {
  const queueNeverSettles = deferred<never>();
  const setup = await fixture(() => queueNeverSettles.promise);
  const abort = new AbortController();
  const blocked = waitSession(
    setup.ports,
    { ...setup.context, abort: abort.signal },
    { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
  );

  expect(await waitForCreatedRequest(setup)).toMatchObject({
    deliveryMode: "queue",
    deliveryState: "prepared",
  });
  abort.abort("test_cleanup");

  expect(await blocked).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  setup.store.close();
});

test("the invocation deadline cancels a queue-admitted blocking request", async () => {
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
  let request = await waitForCreatedRequest(setup);
  for (
    let attempt = 0;
    request.deliveryState !== "delivery_unknown" && attempt < 100;
    attempt += 1
  ) {
    await Promise.resolve();
    request = await waitForCreatedRequest(setup);
  }
  expect(request).toMatchObject({ deliveryMode: "queue", deliveryState: "delivery_unknown" });

  (await invocationDeadline.promise)();

  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  expect(
    await setup.store.getRequestMetadata({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      requestId: request.requestId,
    }),
  ).toMatchObject({ resolutionState: "cancelled", deliveryState: "delivery_unknown" });
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
  let request = await waitForCreatedRequest(setup);
  for (
    let attempt = 0;
    request.deliveryState !== "delivery_unknown" && attempt < 100;
    attempt += 1
  ) {
    await Promise.resolve();
    request = await waitForCreatedRequest(setup);
  }
  expect(request).toMatchObject({ deliveryMode: "queue", deliveryState: "delivery_unknown" });
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

test("a definitively rejected queue admission remains durably terminal and fail-closed", async () => {
  const setup = await fixture(async () => ({ kind: "definitive_rejection" }));

  expect(
    await waitSession(setup.ports, setup.context, {
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
] as const)("fails safely when queue request creation returns %s", async (mode) => {
  const setup = await fixture(async () => {
    throw new Error("native queue must not run");
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

test("a throwing scheduler wake fails closed before queue admission", async () => {
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
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  expect(await waitForCreatedRequest(setup)).toMatchObject({
    deliveryMode: "queue",
    deliveryState: "prepared",
    resolutionState: "pending",
  });
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

test("a queue cancellation committed during create is reported without a native claim", async () => {
  const setup = await fixture(async () => {
    throw new Error("must not queue");
  });
  const requests = Object.create(setup.store) as typeof setup.store;
  const requestCreates = requests as unknown as {
    createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  };
  requestCreates.createPrepared = async (input) => {
    const created = await setup.store.createPrepared(input);
    if (!created.ok) return created;
    await setup.store.cancelPending({
      fencingToken: input.fencingToken,
      workspaceKey: input.request.workspaceKey,
      requestId: input.request.id,
      callerSessionId: setup.source,
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
