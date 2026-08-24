import { afterEach, expect, test } from "bun:test";

import { askSession } from "../../../src/application/ask-session";
import type { SessionBlockingRequestPorts } from "../../../src/application/create-blocking-session-request";
import type {
  PrepareRequestInput,
  RequestClaimResult,
  RequestStoreResult,
  RequestTransitionInput,
} from "../../../src/application/request-ports";
import { respondToSessionRequest } from "../../../src/application/respond-to-session-request";
import { signalSessionRequest } from "../../../src/application/signal-session-request";
import { waitSession } from "../../../src/application/wait-session";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import {
  deferred,
  blockingRequestFixture as fixture,
  requestIdFromEnvelope,
} from "../../support/blocking-request-fixture";
import { cleanupRequestStoreRoots, requestTestWorkspace } from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test("real SQLite ask blocks until a target response commits", async () => {
  const steered = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    steered.resolve(envelope);
    return { kind: "admitted", admittedSeq: 1, observedAtMs: 25_000 };
  });
  const blocked = askSession(setup.ports, setup.context, {
    session_id: setup.target,
    questions: [{ prompt: "Ship?", options: ["yes", "no"] }],
    timeout_seconds: 30,
  });
  const requestId = requestIdFromEnvelope(await steered.promise);
  const response = await respondToSessionRequest(
    setup.mutationPorts,
    {
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      fencingToken: setup.token,
      abort: new AbortController().signal,
      deadlineMs: 90_000,
    },
    { request_id: requestId, answers: [["yes"]] },
  );
  expect(response.ok).toBe(true);
  expect(await blocked).toEqual({
    ok: true,
    value: { request_id: requestId, state: "answered", answers: [["yes"]] },
  });
  setup.store.close();
});

test("real SQLite wait preserves omitted evidence", async () => {
  const steered = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    steered.resolve(envelope);
    return { kind: "admitted", admittedSeq: 2, observedAtMs: 25_000 };
  });
  const blocked = waitSession(setup.ports, setup.context, {
    session_id: setup.target,
    milestone: "compiled",
    timeout_seconds: 30,
  });
  const requestId = requestIdFromEnvelope(await steered.promise);
  const signalled = await signalSessionRequest(
    setup.mutationPorts,
    {
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      fencingToken: setup.token,
      abort: new AbortController().signal,
      deadlineMs: 90_000,
    },
    { request_id: requestId },
  );
  expect(signalled.ok).toBe(true);
  expect(await blocked).toEqual({
    ok: true,
    value: { request_id: requestId, state: "reached" },
  });
  setup.store.close();
});

test("ToolContext abort cancels a durable request while native steer hangs", async () => {
  const steered = deferred<string>();
  const setup = await fixture(
    ({ envelope }) =>
      new Promise((resolve) => {
        steered.resolve(envelope);
        void resolve;
      }),
  );
  const abort = new AbortController();
  const blocked = askSession(
    setup.ports,
    { ...setup.context, abort: abort.signal },
    {
      session_id: setup.target,
      questions: [{ prompt: "Continue?", options: ["yes"] }],
      timeout_seconds: 30,
    },
  );
  await steered.promise;
  abort.abort("caller_cancelled");
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test.each([
  [{ sourceVisible: false, targetVisible: true, targetStatus: "busy" }, "caller_not_visible"],
  [{ sourceVisible: true, targetVisible: false, targetStatus: "busy" }, "target_not_visible"],
  [{ sourceVisible: true, targetVisible: true, targetStatus: "idle" }, "target_idle"],
  [{ sourceVisible: true, targetVisible: true, targetStatus: "unknown" }, "target_status_unknown"],
] as const)("fails closed before persistence for initial activity %#", async (activity, code) => {
  const setup = await fixture(async () => ({ kind: "unknown" }));
  const ports: SessionBlockingRequestPorts = {
    ...setup.ports,
    activity: { observeRequestParticipants: async () => activity },
  };
  const result = await askSession(ports, setup.context, {
    session_id: setup.target,
    questions: [{ prompt: "Ready?", options: ["yes"] }],
    timeout_seconds: 30,
  });
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(
    await setup.store.listForParticipant({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.source,
      role: "outbox",
      limit: 10,
    }),
  ).toMatchObject({ items: [] });
  setup.store.close();
});

test("fails before authorization and target observation when caller membership is unavailable", async () => {
  const setup = await fixture(async () => ({ kind: "unknown" }));
  let activityCalls = 0;
  const result = await waitSession(
    {
      ...setup.ports,
      membership: {
        readCurrentRoots: async () => {
          throw new Error("membership unavailable");
        },
      },
      activity: {
        observeRequestParticipants: async () => {
          activityCalls += 1;
          return { sourceVisible: true, targetVisible: true, targetStatus: "busy" };
        },
      },
    },
    setup.context,
    { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
  expect(activityCalls).toBe(0);
  setup.store.close();
});

test.each([
  ["deny", "permission_denied"],
  ["approval_rejected", "approval_rejected"],
] as const)("authorization %s persists nothing", async (kind, code) => {
  const setup = await fixture(async () => ({ kind: "unknown" }));
  const ports: SessionBlockingRequestPorts = {
    ...setup.ports,
    authorization: { authorizeRequest: async () => ({ kind }) },
  };
  const result = await waitSession(ports, setup.context, {
    session_id: setup.target,
    milestone: "ready",
    timeout_seconds: 30,
  });
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(
    await setup.store.listForParticipant({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.source,
      role: "outbox",
      limit: 10,
    }),
  ).toMatchObject({ items: [] });
  setup.store.close();
});

test("definitive native rejection durably resolves delivery_failed", async () => {
  const setup = await fixture(async () => ({ kind: "definitive_rejection" }));
  const result = await waitSession(setup.ports, setup.context, {
    session_id: setup.target,
    milestone: "ready",
    timeout_seconds: 30,
  });
  expect(result).toMatchObject({ ok: false, error: { code: "delivery_failed" } });
  setup.store.close();
});

test.each(["commit_then_throw", "commit_then_malformed"] as const)(
  "reconciles ambiguous create settlement %s without an ID-less orphan",
  async (mode) => {
    const setup = await fixture(async () => ({ kind: "definitive_rejection" }));
    const requests = Object.create(setup.store) as typeof setup.store;
    const requestCreates = requests as unknown as {
      createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
    };
    requestCreates.createPrepared = async (input) => {
      const committed = await setup.store.createPrepared(input);
      if (mode === "commit_then_throw") throw new Error("settlement lost");
      if (!committed.ok) return committed;
      return { ok: true } as never;
    };
    const result = await waitSession({ ...setup.ports, requests }, setup.context, {
      session_id: setup.target,
      milestone: "ready",
      timeout_seconds: 30,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "delivery_failed" } });
    const outbox = await setup.store.listForParticipant({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.source,
      role: "outbox",
      limit: 10,
    });
    expect(outbox.items).toHaveLength(1);
    setup.store.close();
  },
);

test("claim commit-then-throw is reconciled to delivery_unknown without native steer", async () => {
  let steerCount = 0;
  const setup = await fixture(async () => {
    steerCount += 1;
    return { kind: "unknown" };
  });
  const requests = Object.create(setup.store) as typeof setup.store;
  const requestClaims = requests as unknown as {
    claimPrepared(input: RequestTransitionInput): Promise<RequestClaimResult>;
  };
  const requestCompletions = requests as unknown as {
    completeDelivery: typeof setup.store.completeDelivery;
  };
  requestClaims.claimPrepared = async (input) => {
    await setup.store.claimPrepared(input);
    throw new Error("claim settlement lost");
  };
  requestCompletions.completeDelivery = async (input) => {
    await setup.store.completeDelivery(input);
    return { ok: true } as never;
  };
  const blocked = waitSession({ ...setup.ports, requests }, setup.context, {
    session_id: setup.target,
    milestone: "ready",
    timeout_seconds: 30,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const inbox = await setup.store.listForParticipant({
    fencingToken: setup.token,
    workspaceKey: requestTestWorkspace(),
    callerSessionId: setup.target,
    role: "inbox",
    limit: 10,
  });
  const requestId = inbox.items[0]?.requestId;
  expect(requestId).toBeDefined();
  await signalSessionRequest(
    setup.mutationPorts,
    {
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      fencingToken: setup.token,
      abort: new AbortController().signal,
      deadlineMs: 90_000,
    },
    { request_id: requestId, evidence: "reconciled" },
  );
  expect(await blocked).toMatchObject({ ok: true, value: { state: "reached" } });
  expect(steerCount).toBe(0);
  setup.store.close();
});

test("a precommit claim throw reconciles still-prepared and retries exactly once", async () => {
  let steers = 0;
  const setup = await fixture(async () => {
    steers += 1;
    return { kind: "definitive_rejection" };
  });
  const requests = Object.create(setup.store) as typeof setup.store;
  const requestClaims = requests as unknown as {
    claimPrepared(input: RequestTransitionInput): Promise<RequestClaimResult>;
  };
  const originalClaim = (input: RequestTransitionInput) => setup.store.claimPrepared(input);
  let claims = 0;
  requestClaims.claimPrepared = async (input) => {
    claims += 1;
    if (claims === 1) throw new Error("precommit claim fault");
    return originalClaim(input);
  };
  expect(
    await waitSession({ ...setup.ports, requests }, setup.context, {
      session_id: setup.target,
      milestone: "ready",
      timeout_seconds: 30,
    }),
  ).toMatchObject({ ok: false, error: { code: "delivery_failed" } });
  expect(claims).toBe(2);
  expect(steers).toBe(1);
  setup.store.close();
});

test("malformed claim reconciliation fails closed and remains cancellable", async () => {
  const setup = await fixture(async () => {
    throw new Error("must not steer");
  });
  const abort = new AbortController();
  const requests = Object.create(setup.store) as typeof setup.store;
  requests.claimPrepared = async () => {
    throw new Error("precommit claim fault");
  };
  requests.reconcilePreparedClaim = async () => {
    queueMicrotask(() => abort.abort("test_cleanup"));
    return { outcome: "still_prepared", extra: true } as never;
  };
  expect(
    await waitSession(
      { ...setup.ports, requests },
      { ...setup.context, abort: abort.signal },
      { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test("an absent ambiguous claim reconciliation fails closed and remains cancellable", async () => {
  const setup = await fixture(async () => {
    throw new Error("must not steer");
  });
  const abort = new AbortController();
  const requests = Object.create(setup.store) as typeof setup.store;
  requests.claimPrepared = async () => {
    throw new Error("precommit claim fault");
  };
  requests.reconcilePreparedClaim = async () => {
    setTimeout(() => abort.abort("test_cleanup"), 0);
    return { outcome: "absent_or_other_claim" };
  };
  expect(
    await waitSession(
      { ...setup.ports, requests },
      { ...setup.context, abort: abort.signal },
      { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test("a terminal winner reconciled after a claim throw has no duplicate effect", async () => {
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
    throw new Error("claim settlement lost");
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

test("malformed current-token cleanup faults lifecycle readiness", async () => {
  const setup = await fixture(async () => ({
    kind: "admitted",
    admittedSeq: 12,
    observedAtMs: 25_000,
  }));
  const requests = Object.create(setup.store) as typeof setup.store;
  requests.completeDelivery = async () => ({ ok: true }) as never;
  const faulted = deferred<void>();
  const blocked = waitSession(
    {
      ...setup.ports,
      requests,
      workflowFault: { fault: () => faulted.resolve() },
    },
    setup.context,
    { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
  );
  await faulted.promise;
  const inbox = await setup.store.listForParticipant({
    fencingToken: setup.token,
    workspaceKey: requestTestWorkspace(),
    callerSessionId: setup.target,
    role: "inbox",
    limit: 1,
  });
  await signalSessionRequest(
    setup.mutationPorts,
    {
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      fencingToken: setup.token,
      abort: new AbortController().signal,
      deadlineMs: 90_000,
    },
    { request_id: inbox.items[0]?.requestId, evidence: "faulted" },
  );
  expect(await blocked).toMatchObject({ ok: true, value: { state: "reached" } });
  setup.store.close();
});

test("cleanup recognizes a settled commit after malformed delivery settlement", async () => {
  const setup = await fixture(async () => ({
    kind: "admitted",
    admittedSeq: 13,
    observedAtMs: 25_000,
  }));
  const requests = Object.create(setup.store) as typeof setup.store;
  requests.completeDelivery = async (input) => {
    await setup.store.completeDelivery(input);
    return { ok: true } as never;
  };
  let faults = 0;
  const blocked = waitSession(
    { ...setup.ports, requests, workflowFault: { fault: () => (faults += 1) } },
    setup.context,
    { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const inbox = await setup.store.listForParticipant({
    fencingToken: setup.token,
    workspaceKey: requestTestWorkspace(),
    callerSessionId: setup.target,
    role: "inbox",
    limit: 1,
  });
  await signalSessionRequest(
    setup.mutationPorts,
    {
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      fencingToken: setup.token,
      abort: new AbortController().signal,
      deadlineMs: 90_000,
    },
    { request_id: inbox.items[0]?.requestId, evidence: "settled" },
  );
  expect(await blocked).toMatchObject({ ok: true, value: { state: "reached" } });
  expect(faults).toBe(0);
  setup.store.close();
});

test("a resolved background admission failure is reconciled and wakes durable waiting", async () => {
  const setup = await fixture(async () => ({
    kind: "admitted",
    admittedSeq: 9,
    observedAtMs: 25_000,
  }));
  const requests = Object.create(setup.store) as typeof setup.store;
  const completions = requests as unknown as {
    completeDelivery: typeof setup.store.completeDelivery;
  };
  let completionCalls = 0;
  completions.completeDelivery = async (input) => {
    completionCalls += 1;
    if (completionCalls === 1) return { ok: false, code: "storage_unavailable" };
    return setup.store.completeDelivery(input);
  };
  const blocked = waitSession(
    {
      ...setup.ports,
      requests,
      scheduler: {
        wake: () => {
          throw new Error("best effort wake");
        },
      },
    },
    setup.context,
    { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const inbox = await setup.store.listForParticipant({
    fencingToken: setup.token,
    workspaceKey: requestTestWorkspace(),
    callerSessionId: setup.target,
    role: "inbox",
    limit: 10,
  });
  await signalSessionRequest(
    setup.mutationPorts,
    {
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      fencingToken: setup.token,
      abort: new AbortController().signal,
      deadlineMs: 90_000,
    },
    { request_id: inbox.items[0]?.requestId, evidence: "recovered" },
  );
  expect(await blocked).toMatchObject({ ok: true, value: { state: "reached" } });
  expect(completionCalls).toBe(2);
  setup.store.close();
});

test("active eligibility followed by target idle still performs exactly one steer", async () => {
  let steerCount = 0;
  const steered = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    steerCount += 1;
    steered.resolve(envelope);
    return { kind: "admitted", admittedSeq: 3, observedAtMs: 25_000 };
  });
  let observations = 0;
  const ports: SessionBlockingRequestPorts = {
    ...setup.ports,
    activity: {
      observeRequestParticipants: async () => {
        observations += 1;
        return {
          sourceVisible: true,
          targetVisible: true,
          targetStatus: "busy",
        };
      },
    },
  };
  const blocked = waitSession(ports, setup.context, {
    session_id: setup.target,
    milestone: "ready",
    timeout_seconds: 30,
  });
  await steered.promise;
  const inbox = await setup.store.listForParticipant({
    fencingToken: setup.token,
    workspaceKey: requestTestWorkspace(),
    callerSessionId: setup.target,
    role: "inbox",
    limit: 10,
  });
  const requestId = inbox.items[0]?.requestId;
  expect(requestId).toBeDefined();
  await signalSessionRequest(
    setup.mutationPorts,
    {
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.target,
      fencingToken: setup.token,
      abort: new AbortController().signal,
      deadlineMs: 90_000,
    },
    { request_id: requestId, evidence: "manual" },
  );
  expect(await blocked).toMatchObject({
    ok: true,
    value: { state: "reached", evidence: "manual" },
  });
  expect(observations).toBe(1);
  expect(steerCount).toBe(1);
  setup.store.close();
});

test.each([
  ["deadlock_detected", "deadlock_detected"],
  ["quota_exceeded", "quota_exceeded"],
  ["rate_limited", "rate_limited"],
  ["ownership_lost", "ownership_lost"],
  ["state_conflict", "storage_unavailable"],
  ["storage_unavailable", "storage_unavailable"],
] as const)("maps createPrepared %s without claiming or steering", async (storeCode, code) => {
  const setup = await fixture(async () => {
    throw new Error("must not steer");
  });
  const requests = Object.create(setup.store) as typeof setup.store;
  const requestCreates = requests as unknown as {
    createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  };
  requestCreates.createPrepared = async () => ({ ok: false, code: storeCode });
  const result = await waitSession({ ...setup.ports, requests }, setup.context, {
    session_id: setup.target,
    milestone: "ready",
    timeout_seconds: 30,
  });
  expect(result).toMatchObject({ ok: false, error: { code } });
  setup.store.close();
});

test.each(["malformed", "throws"] as const)(
  "fails closed for %s authorization output",
  async (mode) => {
    const setup = await fixture(async () => ({ kind: "unknown" }));
    const ports = {
      ...setup.ports,
      authorization: {
        authorizeRequest: async () => {
          if (mode === "throws") throw new Error("private");
          return { kind: "unexpected" } as never;
        },
      },
    };
    expect(
      await waitSession(ports, setup.context, {
        session_id: setup.target,
        milestone: "ready",
        timeout_seconds: 30,
      }),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    setup.store.close();
  },
);

test("fails closed for malformed participant activity and generated IDs", async () => {
  const setup = await fixture(async () => ({ kind: "unknown" }));
  expect(
    await waitSession(
      {
        ...setup.ports,
        activity: { observeRequestParticipants: async () => ({ targetStatus: "busy" }) as never },
      },
      setup.context,
      { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
  expect(
    await waitSession(
      {
        ...setup.ports,
        ids: { ...setup.ports.ids, requestId: () => "bad" as never },
      },
      setup.context,
      { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  setup.store.close();
});

test("maps ownership false and ownership port faults before authorization", async () => {
  const first = await fixture(async () => ({ kind: "unknown" }));
  expect(
    await waitSession(
      {
        ...first.ports,
        ownership: { acquire: async () => first.token, isCurrent: async () => false },
      },
      first.context,
      { session_id: first.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  first.store.close();

  const second = await fixture(async () => ({ kind: "unknown" }));
  expect(
    await waitSession(
      {
        ...second.ports,
        ownership: {
          acquire: async () => second.token,
          isCurrent: async () => {
            throw new Error("private");
          },
        },
      },
      second.context,
      { session_id: second.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  second.store.close();
});

test("maps ownership loss from activity and digest/ID adapter faults", async () => {
  const activity = await fixture(async () => ({ kind: "unknown" }));
  expect(
    await waitSession(
      {
        ...activity.ports,
        activity: {
          observeRequestParticipants: async () => {
            throw new OwnershipLostFault("stale");
          },
        },
      },
      activity.context,
      { session_id: activity.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  activity.store.close();

  for (const fault of ["digest", "ids"] as const) {
    const setup = await fixture(async () => ({ kind: "unknown" }));
    const ports: SessionBlockingRequestPorts =
      fault === "digest"
        ? {
            ...setup.ports,
            digest: {
              sha256: async () => {
                throw new Error("private");
              },
            },
          }
        : {
            ...setup.ports,
            ids: {
              ...setup.ports.ids,
              requestId: () => {
                throw new Error("entropy fault");
              },
            },
          };
    expect(
      await waitSession(ports, setup.context, {
        session_id: setup.target,
        milestone: "ready",
        timeout_seconds: 30,
      }),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    setup.store.close();
  }
});
