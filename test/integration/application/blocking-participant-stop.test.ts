import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { askSession } from "../../../src/application/ask-session";
import { ParticipantStopLifecycle } from "../../../src/application/participant-stop-lifecycle";
import { stopSession } from "../../../src/application/stop-session";
import { waitSession } from "../../../src/application/wait-session";
import { validateDeliveryId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateSessionId } from "../../../src/domain/sessions";
import { blockingRequestFixture, deferred } from "../../support/blocking-request-fixture";
import { cleanupRequestStoreRoots, requestTestWorkspace } from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

const digest = {
  async sha256(bytes: Uint8Array) {
    return new Uint8Array(createHash("sha256").update(bytes).digest());
  },
};

function contextMessageInput(
  setup: Awaited<ReturnType<typeof blockingRequestFixture>>,
  index: number,
  sourceSessionId = setup.source,
  targetSessionId = setup.target,
) {
  const id = validateDeliveryId(`dlv_${index.toString(16).padStart(32, "0")}`);
  if (!id.ok) throw new Error(id.message);
  const envelopeJson = JSON.stringify({ content: `message-${index}` });
  return {
    fencingToken: setup.token,
    id: id.value,
    workspaceKey: requestTestWorkspace(),
    sourceSessionId,
    targetSessionId,
    envelopeJson,
    contentByteLength: Buffer.byteLength(envelopeJson),
    contentSha256: createHash("sha256").update(envelopeJson).digest("hex") as Sha256Digest,
    createdAtMs: 24_000 + index,
  } as const;
}

test.each(["ask", "wait"] as const)(
  "approved session_stop releases a blocked %s with target_stopped",
  async (kind) => {
    const queued = deferred<void>();
    const setup = await blockingRequestFixture(async () => {
      queued.resolve();
      return { kind: "public_message", observedAtMs: 25_000 };
    });
    const blocked =
      kind === "ask"
        ? askSession(setup.ports, setup.context, {
            session_id: setup.target,
            questions: [{ prompt: "Continue?", options: ["yes"] }],
            timeout_seconds: 30,
          })
        : waitSession(setup.ports, setup.context, {
            session_id: setup.target,
            milestone: "complete",
            timeout_seconds: 30,
          });
    await queued.promise;
    const stopped = await stopSession(
      {
        readiness: { fencingToken: setup.token, assertReady: () => undefined },
        activity: {
          observeRequestParticipants: async () => ({
            sourceVisible: true,
            targetVisible: true,
            targetStatus: "idle",
          }),
        },
        approval: { requestStopApproval: async () => "approved" },
        requests: setup.store,
        nativeInterrupt: { interruptSession: async () => "interrupted" },
        ownership: setup.store,
        notifications: setup.runtime,
        participantOperations: setup.ports.participantOperations,
        digest,
      },
      {
        workspaceKey: requestTestWorkspace(),
        sourceSessionId: setup.source,
        abort: new AbortController().signal,
      },
      { session_id: setup.target },
    );
    expect(stopped).toMatchObject({ ok: true, value: { nativeOutcome: "already_idle" } });
    expect(await blocked).toMatchObject({ ok: false, error: { code: "target_stopped" } });
    setup.store.close();
  },
);

test("missed idle events reconcile message-only context participants with role-correct outcomes", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const idleTarget = validateSessionId("ses_idleTarget");
  const idleSource = validateSessionId("ses_idleSource");
  const otherA = validateSessionId("ses_otherA");
  const otherB = validateSessionId("ses_otherB");
  if (!idleTarget.ok || !idleSource.ok || !otherA.ok || !otherB.ok)
    throw new Error("invalid fixture");
  const targeted = contextMessageInput(setup, 201, otherA.value, idleTarget.value);
  const sourced = contextMessageInput(setup, 202, idleSource.value, otherB.value);
  expect((await setup.store.createContextMessage(targeted)).ok).toBe(true);
  expect((await setup.store.createContextMessage(sourced)).ok).toBe(true);
  let wake: (() => void) | undefined;
  const lifecycle = new ParticipantStopLifecycle({
    requests: setup.store,
    activity: {
      observeParticipantActivities: async (_workspace, sessionIds) =>
        sessionIds.map((sessionId) => ({
          sessionId,
          activity:
            sessionId === idleTarget.value || sessionId === idleSource.value
              ? ("idle" as const)
              : ("busy" as const),
        })),
    },
    operations: setup.ports.participantOperations,
    notifications: setup.runtime,
    contexts: setup.store,
    contextNotifications: setup.contextRuntime,
    lifecycle: {
      fencingToken: setup.token,
      status: "ready",
      effectSignal: setup.runtime.effectSignal,
      stop: () => undefined,
    } as never,
    workspaceKey: requestTestWorkspace(),
    timers: {
      set: (_delay, callback) => {
        wake = callback;
        return 1;
      },
      clear: () => undefined,
    },
  });
  wake?.();
  for (let index = 0; index < 100; index += 1) {
    const target = await setup.store.getContextAdmission({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      id: targeted.id,
    });
    const source = await setup.store.getContextAdmission({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      id: sourced.id,
    });
    if (target?.state === "failed" && source?.state === "cancelled") break;
    await Promise.resolve();
  }
  expect(
    await setup.store.getContextAdmission({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      id: targeted.id,
    }),
  ).toMatchObject({ state: "failed" });
  expect(
    await setup.store.getContextAdmission({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      id: sourced.id,
    }),
  ).toMatchObject({ state: "cancelled" });
  await lifecycle.dispose();
  setup.store.close();
});

test("stopping the source releases its blocked request with source_stopped", async () => {
  const queued = deferred<void>();
  const setup = await blockingRequestFixture(async () => {
    queued.resolve();
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  const blocked = waitSession(setup.ports, setup.context, {
    session_id: setup.target,
    milestone: "complete",
    timeout_seconds: 30,
  });
  await queued.promise;
  const operator = validateSessionId("ses_operator");
  if (!operator.ok) throw new Error("invalid fixture");
  await stopSession(
    {
      readiness: { fencingToken: setup.token, assertReady: () => undefined },
      activity: {
        observeRequestParticipants: async () => ({
          sourceVisible: true,
          targetVisible: true,
          targetStatus: "idle",
        }),
      },
      approval: { requestStopApproval: async () => "approved" },
      requests: setup.store,
      nativeInterrupt: { interruptSession: async () => "interrupted" },
      ownership: setup.store,
      notifications: setup.runtime,
      participantOperations: setup.ports.participantOperations,
      digest,
    },
    {
      workspaceKey: requestTestWorkspace(),
      sourceSessionId: operator.value,
      abort: new AbortController().signal,
    },
    { session_id: setup.source },
  );
  expect(await blocked).toMatchObject({ ok: false, error: { code: "source_stopped" } });
  setup.store.close();
});

test.each(["ask", "wait"] as const)(
  "an idle event does not terminalize a queue-delivered %s",
  async (kind) => {
    const queued = deferred<void>();
    const setup = await blockingRequestFixture(async () => {
      queued.resolve();
      return { kind: "public_message", observedAtMs: 25_000 };
    });
    const abort = new AbortController();
    const blocked =
      kind === "ask"
        ? askSession(
            setup.ports,
            { ...setup.context, abort: abort.signal },
            {
              session_id: setup.target,
              questions: [{ prompt: "Continue?", options: ["yes"] }],
              timeout_seconds: 30,
            },
          )
        : waitSession(
            setup.ports,
            { ...setup.context, abort: abort.signal },
            {
              session_id: setup.target,
              milestone: "complete",
              timeout_seconds: 30,
            },
          );
    await queued.promise;
    const lifecycle = new ParticipantStopLifecycle({
      requests: setup.store,
      activity: {
        observeParticipantActivities: async (_workspace, sessionIds) =>
          sessionIds.map((sessionId) => ({ sessionId, activity: "idle" as const })),
      },
      operations: setup.ports.participantOperations,
      notifications: setup.runtime,
      lifecycle: {
        fencingToken: setup.token,
        status: "ready",
        effectSignal: setup.runtime.effectSignal,
        stop: () => undefined,
      } as never,
      workspaceKey: requestTestWorkspace(),
      timers: { set: () => 1, clear: () => undefined },
    });
    await lifecycle.handle(
      kind === "ask"
        ? { id: "evt_idle", created: 1, type: "session.idle", data: { sessionID: setup.target } }
        : {
            id: "evt_status",
            created: 1,
            type: "session.status",
            data: { sessionID: setup.target, status: { type: "idle" } },
          },
    );
    expect(
      await setup.store.listForParticipant({
        fencingToken: setup.token,
        workspaceKey: requestTestWorkspace(),
        callerSessionId: setup.source,
        role: "outbox",
        limit: 1,
      }),
    ).toMatchObject({ items: [{ deliveryMode: "queue", resolutionState: "pending" }] });
    abort.abort("test_cleanup");
    expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    await lifecycle.dispose();
    setup.store.close();
  },
);

test("queue request creation does not require a participant activity observation", async () => {
  const queued = deferred<void>();
  const setup = await blockingRequestFixture(async () => {
    queued.resolve();
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  let activityCalls = 0;
  setup.ports.activity.observeRequestParticipants = async () => {
    activityCalls += 1;
    return { sourceVisible: true, targetVisible: true, targetStatus: "busy" as const };
  };
  const abort = new AbortController();
  const blocked = waitSession(
    setup.ports,
    { ...setup.context, abort: abort.signal },
    {
      session_id: setup.target,
      milestone: "complete",
      timeout_seconds: 30,
    },
  );
  await queued.promise;
  expect(activityCalls).toBe(0);
  abort.abort("test_cleanup");
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test("idle reconciliation that acquires the gate first does not stop a later queue request", async () => {
  const idleObserved = deferred<void>();
  const releaseIdle = deferred<void>();
  const queued = deferred<void>();
  const setup = await blockingRequestFixture(async () => {
    queued.resolve();
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  const lifecycle = new ParticipantStopLifecycle({
    requests: setup.store,
    activity: {
      observeParticipantActivities: async (_workspace, sessionIds) => {
        idleObserved.resolve();
        await releaseIdle.promise;
        return sessionIds.map((sessionId) => ({ sessionId, activity: "idle" as const }));
      },
    },
    operations: setup.ports.participantOperations,
    notifications: setup.runtime,
    lifecycle: {
      fencingToken: setup.token,
      status: "ready",
      effectSignal: setup.runtime.effectSignal,
      stop: () => undefined,
    } as never,
    workspaceKey: requestTestWorkspace(),
    timers: { set: () => 1, clear: () => undefined },
  });
  const firstIdle = lifecycle.handle({
    id: "evt_idle_first",
    created: 1,
    type: "session.idle",
    data: { sessionID: setup.target },
  });
  await idleObserved.promise;
  const abort = new AbortController();
  const blocked = waitSession(
    setup.ports,
    { ...setup.context, abort: abort.signal },
    {
      session_id: setup.target,
      milestone: "complete",
      timeout_seconds: 30,
    },
  );
  releaseIdle.resolve();
  await firstIdle;
  await queued.promise;
  await lifecycle.handle({
    id: "evt_idle_second",
    created: 2,
    type: "session.idle",
    data: { sessionID: setup.target },
  });
  expect(
    await setup.store.listForParticipant({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.source,
      role: "outbox",
      limit: 1,
    }),
  ).toMatchObject({ items: [{ deliveryMode: "queue", resolutionState: "pending" }] });
  abort.abort("test_cleanup");
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  await lifecycle.dispose();
  setup.store.close();
});
