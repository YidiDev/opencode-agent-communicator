import { afterEach, expect, test } from "bun:test";

import type {
  PrepareRequestInput,
  RequestClaimResult,
  RequestStoreResult,
  RequestTransitionInput,
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

test("a durable request deadline aborts held admission before native steer", async () => {
  let steerCalls = 0;
  const setup = await fixture(async () => {
    steerCalls += 1;
    return { kind: "unknown" };
  });
  const admissionOwnership = deferred<void>();
  const releaseOwnership = deferred<boolean>();
  const requestDeadlineWake = deferred<() => void>();
  let ownershipChecks = 0;
  const abort = new AbortController();
  const blocked = waitSession(
    {
      ...setup.ports,
      ownership: {
        acquire: () => setup.store.acquire(),
        isCurrent: async (fencingToken) => {
          ownershipChecks += 1;
          if (ownershipChecks === 4) {
            admissionOwnership.resolve();
            return releaseOwnership.promise;
          }
          return setup.store.isCurrent(fencingToken);
        },
      },
      deadlineTimer: {
        arm: (delayMs, wake) => {
          if (delayMs === 1_000) requestDeadlineWake.resolve(wake);
          return { cancel: () => undefined };
        },
      },
    },
    { ...setup.context, abort: abort.signal },
    { session_id: setup.target, milestone: "ready", timeout_seconds: 1 },
  );
  await admissionOwnership.promise;
  (await requestDeadlineWake.promise)();
  releaseOwnership.resolve(true);

  let reconciled: Awaited<ReturnType<typeof setup.store.reconcilePreparedClaim>> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inbox = await setup.store.listForParticipant({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      role: "inbox",
      limit: 1,
    });
    const requestId = inbox.items[0]?.requestId;
    if (requestId) {
      reconciled = await setup.store.reconcilePreparedClaim({
        fencingToken: setup.token,
        workspaceKey: requestTestWorkspace(),
        requestId,
      });
      if (reconciled.outcome === "settled") break;
    }
    await Promise.resolve();
  }
  expect(steerCalls).toBe(0);
  expect(reconciled).toMatchObject({
    outcome: "settled",
    request: { deliveryState: "delivery_unknown" },
  });
  abort.abort("test_cleanup");
  expect(await blocked).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  setup.store.close();
});

test("a durable deadline reached during ownership admission prevents native steer without a timer wake", async () => {
  let nowMs = 25_000;
  let steerCalls = 0;
  const setup = await fixture(async () => {
    steerCalls += 1;
    return { kind: "unknown" };
  });
  const admissionOwnership = deferred<void>();
  const releaseOwnership = deferred<boolean>();
  let ownershipChecks = 0;
  let withheldTimerCallbacks = 0;
  const abort = new AbortController();
  const blocked = waitSession(
    {
      ...setup.ports,
      clock: { nowMs: () => nowMs },
      ownership: {
        acquire: () => setup.store.acquire(),
        isCurrent: async (fencingToken) => {
          ownershipChecks += 1;
          if (ownershipChecks === 4) {
            admissionOwnership.resolve();
            return releaseOwnership.promise;
          }
          return setup.store.isCurrent(fencingToken);
        },
      },
      deadlineTimer: {
        arm: () => {
          withheldTimerCallbacks += 1;
          return { cancel: () => undefined };
        },
      },
    },
    { ...setup.context, abort: abort.signal },
    { session_id: setup.target, milestone: "ready", timeout_seconds: 1 },
  );
  await admissionOwnership.promise;
  const inbox = await setup.store.listForParticipant({
    fencingToken: setup.token,
    workspaceKey: requestTestWorkspace(),
    callerSessionId: setup.target,
    role: "inbox",
    limit: 1,
  });
  const requestId = inbox.items[0]?.requestId;
  expect(requestId).toBeDefined();
  expect(nowMs).toBeLessThan(26_000);
  nowMs = 26_001;
  releaseOwnership.resolve(true);

  let reconciled: Awaited<ReturnType<typeof setup.store.reconcilePreparedClaim>> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (requestId) {
      reconciled = await setup.store.reconcilePreparedClaim({
        fencingToken: setup.token,
        workspaceKey: requestTestWorkspace(),
        requestId,
      });
      if (reconciled.outcome === "settled") break;
    }
    await Promise.resolve();
  }
  expect(withheldTimerCallbacks).toBeGreaterThan(0);
  expect(steerCalls).toBe(0);
  expect(reconciled).toMatchObject({
    outcome: "settled",
    request: { deadlineAtMs: 26_000, deliveryState: "delivery_unknown" },
  });
  abort.abort("test_cleanup");
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test("a cancel commit with lost settlement uses a fresh bounded authoritative read", async () => {
  const steered = deferred<void>();
  const setup = await fixture(async () => {
    steered.resolve();
    return { kind: "admitted", admittedSeq: 3, observedAtMs: 25_000 };
  });
  const requests = Object.create(setup.store) as typeof setup.store;
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
  await steered.promise;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inbox = await setup.store.listForParticipant({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      role: "inbox",
      limit: 1,
    });
    const requestId = inbox.items[0]?.requestId;
    if (requestId) {
      const admission = await setup.store.reconcilePreparedClaim({
        fencingToken: setup.token,
        workspaceKey: requestTestWorkspace(),
        requestId,
      });
      if (admission.outcome === "settled" && admission.request.deliveryState === "admitted") break;
    }
    await Promise.resolve();
  }
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

test.each(["failed", "hung"] as const)(
  "caller abort with hung steer and %s completion faults only the current fenced owner",
  async (completionMode) => {
    for (const stale of [false, true]) {
      let steerStarted = (): void => undefined;
      const steered = new Promise<void>((resolve) => {
        steerStarted = resolve;
      });
      const setup = await fixture(
        () =>
          new Promise(() => {
            steerStarted();
          }),
      );
      const requests = Object.create(setup.store) as typeof setup.store;
      requests.cancelPending = async () => new Promise(() => undefined);
      requests.completeDelivery = async () =>
        completionMode === "failed"
          ? { ok: false, code: "storage_unavailable" }
          : new Promise(() => undefined);
      let ownedToken = setup.token;
      let faults = 0;
      let callerAborted = false;
      let resolveOwnershipProbe = (): void => undefined;
      const ownershipProbed = new Promise<void>((resolve) => {
        resolveOwnershipProbe = resolve;
      });
      let resolveFault = (): void => undefined;
      const faulted = new Promise<void>((resolve) => {
        resolveFault = resolve;
      });
      const abort = new AbortController();
      const blocked = waitSession(
        {
          ...setup.ports,
          requests,
          ownership: {
            acquire: () => setup.store.acquire(),
            isCurrent: async (fencingToken) => {
              const current =
                stale && callerAborted ? false : await setup.store.isCurrent(fencingToken);
              if (callerAborted) resolveOwnershipProbe();
              return current;
            },
          },
          deadlineTimer: {
            arm: (delayMs, wake) => {
              if (delayMs === 1_000) setTimeout(wake, 0);
              return { cancel: () => undefined };
            },
          },
          workflowFault: {
            fault: (input) => {
              if (input.fencingToken === ownedToken) {
                faults += 1;
                resolveFault();
              }
            },
          },
        },
        { ...setup.context, abort: abort.signal },
        { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
      );
      await steered;
      if (stale) ownedToken = (Number(setup.token) + 1) as typeof setup.token;
      callerAborted = true;
      abort.abort("caller_cancelled");
      expect(await blocked).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
      await ownershipProbed;
      if (!stale) await faulted;
      await Promise.resolve();
      expect(faults).toBe(stale ? 0 : 1);
      setup.store.close();
    }
  },
);

test.each(["throws", "malformed", "extra", "ownership_lost", "quota_exceeded"] as const)(
  "keeps the durable request cancellable when claimPrepared %s",
  async (mode) => {
    const setup = await fixture(async () => {
      throw new Error("must not steer");
    });
    const requests = Object.create(setup.store) as typeof setup.store;
    const abort = new AbortController();
    requests.claimPrepared = async () => {
      queueMicrotask(() => abort.abort("test_cleanup"));
      if (mode === "throws") throw new Error("private");
      if (mode === "malformed") return { ok: true } as never;
      if (mode === "extra") return { ok: false, code: "quota_exceeded", extra: true } as never;
      return { ok: false, code: mode };
    };
    expect(
      await waitSession(
        { ...setup.ports, requests },
        { ...setup.context, abort: abort.signal },
        {
          session_id: setup.target,
          milestone: "ready",
          timeout_seconds: 30,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    setup.store.close();
  },
);

test.each(["quota_exceeded", "rate_limited"] as const)(
  "a settled claim %s failure is not reconciled and remains cancellable",
  async (code) => {
    const setup = await fixture(async () => {
      throw new Error("must not steer");
    });
    const abort = new AbortController();
    const requests = Object.create(setup.store) as typeof setup.store;
    requests.claimPrepared = async () => {
      setTimeout(() => abort.abort("test_cleanup"), 0);
      return { ok: false, code };
    };
    expect(
      await waitSession(
        { ...setup.ports, requests },
        { ...setup.context, abort: abort.signal },
        {
          session_id: setup.target,
          milestone: "ready",
          timeout_seconds: 30,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    setup.store.close();
  },
);

test("a claim-time terminal winner notifies without native admission", async () => {
  const setup = await fixture(async () => {
    throw new Error("must not steer");
  });
  const requests = Object.create(setup.store) as typeof setup.store;
  const requestClaims = requests as unknown as {
    claimPrepared(input: RequestTransitionInput): Promise<RequestClaimResult>;
  };
  requestClaims.claimPrepared = async (input) => {
    const cancelled = await setup.store.cancelPending({
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      requestId: input.requestId,
      callerSessionId: setup.source,
    });
    if (!cancelled.ok) throw new Error("cancellation fixture failed");
    return { ok: true, request: cancelled.request };
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

test.each(["throws", "non_undefined"] as const)(
  "scheduler wake fault %s cannot reverse a committed request",
  async (mode) => {
    const setup = await fixture(async () => ({ kind: "definitive_rejection" }));
    const scheduler = {
      wake: () => {
        if (mode === "throws") throw new Error("wake fault");
        return Promise.reject(new Error("contract fault")) as never;
      },
    };
    expect(
      await waitSession({ ...setup.ports, scheduler }, setup.context, {
        session_id: setup.target,
        milestone: "ready",
        timeout_seconds: 30,
      }),
    ).toMatchObject({ ok: false, error: { code: "delivery_failed" } });
    setup.store.close();
  },
);

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

test.each(["error", "ownership_lost", "wrong_state"] as const)(
  "fails safely when createPrepared returns %s",
  async (mode) => {
    const setup = await fixture(async () => ({ kind: "unknown" }));
    const requests = Object.create(setup.store) as typeof setup.store;
    const requestCreates = requests as unknown as {
      createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
    };
    const abort = new AbortController();
    requestCreates.createPrepared = async (input) => {
      if (mode === "error") throw new Error("private");
      if (mode === "ownership_lost") throw new OwnershipLostFault("stale");
      const created = await setup.store.createPrepared(input);
      if (!created.ok) return created;
      const claimed = await setup.store.claimPrepared({
        fencingToken: setup.token,
        workspaceKey: requestTestWorkspace(),
        requestId: created.request.id,
      });
      if (!claimed.ok) return claimed;
      queueMicrotask(() => abort.abort("test_cleanup"));
      return { ok: true, request: claimed.request };
    };
    expect(
      await waitSession(
        { ...setup.ports, requests },
        { ...setup.context, abort: abort.signal },
        {
          session_id: setup.target,
          milestone: "ready",
          timeout_seconds: 30,
        },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code:
          mode === "ownership_lost"
            ? "ownership_lost"
            : mode === "wrong_state"
              ? "request_cancelled"
              : "storage_unavailable",
      },
    });
    setup.store.close();
  },
);
