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
      activity: { observeParticipantActivity: async () => "idle" },
      operations: setup.ports.participantOperations,
      notifications: setup.runtime,
      lifecycle: {
        fencingToken: setup.token,
        status: "ready",
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
