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

test("queue-delivered SQLite ask does not require a busy target", async () => {
  const queued = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    queued.resolve(envelope);
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  const blocked = askSession(
    {
      ...setup.ports,
      activity: {
        observeRequestParticipants: async () => ({
          sourceVisible: true,
          targetVisible: true,
          targetStatus: "idle",
        }),
      },
    },
    setup.context,
    {
      session_id: setup.target,
      questions: [{ prompt: "Ship?", options: ["yes", "no"] }],
      timeout_seconds: 30,
    },
  );
  const requestId = requestIdFromEnvelope(await queued.promise);
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

test("queue-delivered SQLite wait does not require a known target status", async () => {
  const queued = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    queued.resolve(envelope);
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  const blocked = waitSession(
    {
      ...setup.ports,
      activity: {
        observeRequestParticipants: async () => ({
          sourceVisible: true,
          targetVisible: true,
          targetStatus: "unknown",
        }),
      },
    },
    setup.context,
    {
      session_id: setup.target,
      milestone: "compiled",
      timeout_seconds: 30,
    },
  );
  const requestId = requestIdFromEnvelope(await queued.promise);
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

test("caller abort cancels a durable queue request", async () => {
  const queued = deferred<string>();
  const setup = await fixture(async ({ envelope }) => {
    queued.resolve(envelope);
    return { kind: "public_message", observedAtMs: 25_000 };
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
  await queued.promise;
  abort.abort("caller_cancelled");
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test.each([
  [{ sourceTitle: undefined, sourceVisible: false, targetVisible: true }, "caller_not_visible"],
  [{ sourceTitle: undefined, sourceVisible: true, targetVisible: false }, "target_not_visible"],
] as const)(
  "fails before persistence for invisible queue participant %#",
  async (membership, code) => {
    const setup = await fixture(async () => ({ kind: "unknown" }));
    const ports: SessionBlockingRequestPorts = {
      ...setup.ports,
      membership: { readCurrentRoots: async () => membership },
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
] as const)("authorization %s persists no queue request", async (kind, code) => {
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
