import { afterEach, expect, test } from "bun:test";

import { askSession } from "../../../src/application/ask-session";
import type { SessionBlockingRequestPorts } from "../../../src/application/create-blocking-session-request";
import { respondToSessionRequest } from "../../../src/application/respond-to-session-request";
import { signalSessionRequest } from "../../../src/application/signal-session-request";
import { waitSession } from "../../../src/application/wait-session";
import {
  deferred,
  blockingRequestFixture as fixture,
  requestIdFromEnvelope,
} from "../../support/blocking-request-fixture";
import { cleanupRequestStoreRoots, requestTestWorkspace } from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test("context-admitted SQLite ask blocks until a target response commits", async () => {
  const injected = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    injected.resolve(envelope);
    return { kind: "admitted", admittedSeq: 1, observedAtMs: 25_000 };
  });
  const blocked = askSession(setup.ports, setup.context, {
    session_id: setup.target,
    questions: [{ prompt: "Ship?", options: ["yes", "no"] }],
    timeout_seconds: 30,
  });
  const requestId = requestIdFromEnvelope(await injected.promise);
  expect(
    await respondToSessionRequest(
      setup.mutationPorts,
      {
        workspaceKey: requestTestWorkspace(),
        callerSessionId: setup.target,
        fencingToken: setup.token,
        abort: new AbortController().signal,
        deadlineMs: 90_000,
      },
      { request_id: requestId, answers: [["yes"]] },
    ),
  ).toMatchObject({ ok: true });
  expect(await blocked).toEqual({
    ok: true,
    value: { request_id: requestId, state: "answered", answers: [["yes"]] },
  });
  setup.store.close();
});

test("context-admitted SQLite wait preserves omitted evidence", async () => {
  const injected = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    injected.resolve(envelope);
    return { kind: "admitted", admittedSeq: 2, observedAtMs: 25_000 };
  });
  const blocked = waitSession(setup.ports, setup.context, {
    session_id: setup.target,
    milestone: "compiled",
    timeout_seconds: 30,
  });
  const requestId = requestIdFromEnvelope(await injected.promise);
  expect(
    await signalSessionRequest(
      setup.mutationPorts,
      {
        workspaceKey: requestTestWorkspace(),
        callerSessionId: setup.target,
        fencingToken: setup.token,
        abort: new AbortController().signal,
        deadlineMs: 90_000,
      },
      { request_id: requestId },
    ),
  ).toMatchObject({ ok: true });
  expect(await blocked).toEqual({
    ok: true,
    value: { request_id: requestId, state: "reached" },
  });
  setup.store.close();
});

test("caller abort cancels a durable context request", async () => {
  const injected = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    injected.resolve(envelope);
    return { kind: "admitted", admittedSeq: 3, observedAtMs: 25_000 };
  });
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
  await injected.promise;
  abort.abort("caller_cancelled");
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test.each([
  [{ sourceVisible: false, targetVisible: true, targetStatus: "busy" }, "caller_not_visible"],
  [{ sourceVisible: true, targetVisible: false, targetStatus: "busy" }, "target_not_visible"],
  [{ sourceVisible: true, targetVisible: true, targetStatus: "idle" }, "target_idle"],
  [{ sourceVisible: true, targetVisible: true, targetStatus: "unknown" }, "target_status_unknown"],
] as const)(
  "fails before persistence for inactive context participant %#",
  async (activity, code) => {
    const setup = await fixture(async () => ({ kind: "unknown" }));
    const ports: SessionBlockingRequestPorts = {
      ...setup.ports,
      activity: { observeRequestParticipants: async () => activity },
    };
    expect(
      await askSession(ports, setup.context, {
        session_id: setup.target,
        questions: [{ prompt: "Ready?", options: ["yes"] }],
        timeout_seconds: 30,
      }),
    ).toMatchObject({ ok: false, error: { code } });
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
  },
);

test.each([
  ["deny", "permission_denied"],
  ["approval_rejected", "approval_rejected"],
] as const)("authorization %s persists no context request", async (kind, code) => {
  const setup = await fixture(async () => ({ kind: "unknown" }));
  expect(
    await waitSession(
      { ...setup.ports, authorization: { authorizeRequest: async () => ({ kind }) } },
      setup.context,
      { session_id: setup.target, milestone: "ready", timeout_seconds: 30 },
    ),
  ).toMatchObject({ ok: false, error: { code } });
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
