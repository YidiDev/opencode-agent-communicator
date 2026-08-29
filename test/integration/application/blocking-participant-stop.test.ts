import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { askSession } from "../../../src/application/ask-session";
import { ParticipantStopLifecycle } from "../../../src/application/participant-stop-lifecycle";
import { stopSession } from "../../../src/application/stop-session";
import { waitSession } from "../../../src/application/wait-session";
import { validateSessionId } from "../../../src/domain/sessions";
import { blockingRequestFixture, deferred } from "../../support/blocking-request-fixture";
import { cleanupRequestStoreRoots, requestTestWorkspace } from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

const digest = {
  async sha256(bytes: Uint8Array) {
    return new Uint8Array(createHash("sha256").update(bytes).digest());
  },
};

test.each(["ask", "wait"] as const)(
  "approved session_stop releases a blocked %s with target_stopped",
  async (kind) => {
    const steered = deferred<void>();
    const setup = await blockingRequestFixture(async () => {
      steered.resolve();
      return { kind: "admitted", admittedSeq: 1, observedAtMs: 25_000 };
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
    await steered.promise;
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

test("stopping the source releases its blocked request with source_stopped", async () => {
  const steered = deferred<void>();
  const setup = await blockingRequestFixture(async () => {
    steered.resolve();
    return { kind: "admitted", admittedSeq: 1, observedAtMs: 25_000 };
  });
  const blocked = waitSession(setup.ports, setup.context, {
    session_id: setup.target,
    milestone: "complete",
    timeout_seconds: 30,
  });
  await steered.promise;
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
  "an authoritatively idle native participant releases a blocked %s",
  async (kind) => {
    const steered = deferred<void>();
    const setup = await blockingRequestFixture(async () => {
      steered.resolve();
      return { kind: "admitted", admittedSeq: 1, observedAtMs: 25_000 };
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
    await steered.promise;
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
        ? { type: "session.idle", properties: { sessionID: setup.target } }
        : {
            type: "session.status",
            properties: { sessionID: setup.target, status: { type: "idle" } },
          },
    );
    expect(await blocked).toMatchObject({ ok: false, error: { code: "target_stopped" } });
    await lifecycle.dispose();
    setup.store.close();
  },
);

test("request creation that acquires the gate first is terminalized by the queued idle hint", async () => {
  const creationObserved = deferred<void>();
  const releaseCreation = deferred<void>();
  const steered = deferred<void>();
  const setup = await blockingRequestFixture(async () => {
    steered.resolve();
    return { kind: "admitted", admittedSeq: 1, observedAtMs: 25_000 };
  });
  setup.ports.activity.observeRequestParticipants = async () => {
    creationObserved.resolve();
    await releaseCreation.promise;
    return { sourceVisible: true, targetVisible: true, targetStatus: "busy" as const };
  };
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
  const blocked = waitSession(setup.ports, setup.context, {
    session_id: setup.target,
    milestone: "complete",
    timeout_seconds: 30,
  });
  await creationObserved.promise;
  const idle = lifecycle.handle({
    type: "session.idle",
    properties: { sessionID: setup.target },
  });
  releaseCreation.resolve();
  await steered.promise;
  await idle;
  expect(await blocked).toMatchObject({ ok: false, error: { code: "target_stopped" } });
  await lifecycle.dispose();
  setup.store.close();
});

test("idle reconciliation that acquires the gate first completes before request creation", async () => {
  const idleObserved = deferred<void>();
  const releaseIdle = deferred<void>();
  const authorized = deferred<void>();
  const steered = deferred<void>();
  const setup = await blockingRequestFixture(async () => {
    steered.resolve();
    return { kind: "admitted", admittedSeq: 1, observedAtMs: 25_000 };
  });
  setup.ports.authorization.authorizeRequest = async () => {
    authorized.resolve();
    return { kind: "allow" as const };
  };
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
    type: "session.idle",
    properties: { sessionID: setup.target },
  });
  await idleObserved.promise;
  const blocked = waitSession(setup.ports, setup.context, {
    session_id: setup.target,
    milestone: "complete",
    timeout_seconds: 30,
  });
  await authorized.promise;
  await Promise.resolve();
  releaseIdle.resolve();
  await firstIdle;
  await steered.promise;
  await lifecycle.handle({
    type: "session.idle",
    properties: { sessionID: setup.target },
  });
  expect(await blocked).toMatchObject({ ok: false, error: { code: "target_stopped" } });
  await lifecycle.dispose();
  setup.store.close();
});
