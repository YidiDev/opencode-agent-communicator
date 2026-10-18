import { afterEach, expect, test } from "bun:test";

import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
import { createSessionRequestSendTool } from "../../../src/tools/session-request-send";
import { createSessionRequestStartTool } from "../../../src/tools/session-request-start";
import { blockingRequestFixture } from "../../support/blocking-request-fixture";
import {
  cleanupRequestStoreRoots,
  requestDigestPort,
  requestTestWorkspace,
} from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test("request-send durably uses public queue admission", async () => {
  let fixtureQueueCalls = 0;
  const setup = await blockingRequestFixture(async () => {
    fixtureQueueCalls += 1;
    return { kind: "unknown" };
  });
  let queueCalls = 0;
  const tool = createSessionRequestSendTool(
    {
      readiness: { ...setup.ports.readiness, fencingToken: setup.token },
      membership: setup.ports.membership,
      requests: setup.ports.requests,
      scheduler: setup.ports.scheduler,
      nativeQueue: {
        queueMessage: async () => {
          queueCalls += 1;
          return { kind: "public_message", observedAtMs: 25_000 };
        },
      },
      contexts: setup.store,
      contextRuntime: setup.contextRuntime,
      activity: setup.ports.activity,
      participantOperations: setup.ports.participantOperations,
      ownership: setup.store,
      clock: setup.ports.clock,
      ids: setup.ports.ids,
      digest: requestDigestPort,
    },
    {
      workspaceKey: requestTestWorkspace(),
      fencingToken: setup.token,
      invocationDeadlineMs: () => 90_000,
    },
    { message: "allow", ask: "allow", wait: "allow" },
  );

  const result = JSON.parse(
    await tool.execute(
      {
        session_id: setup.target,
        content: "Do the work.",
        request: { kind: "wait", milestone: "done", timeout_seconds: 30 },
      },
      { sessionID: setup.source, abort: new AbortController().signal },
    ),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { delivery_mode: "queue", delivery_state: "delivery_unknown" },
  });
  expect(fixtureQueueCalls).toBe(0);
  expect(queueCalls).toBe(1);
  setup.store.close();
});

test("request-send admits an idle visible target without activity gating", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const tool = createSessionRequestSendTool(
    {
      readiness: { ...setup.ports.readiness, fencingToken: setup.token },
      membership: setup.ports.membership,
      requests: setup.ports.requests,
      scheduler: setup.ports.scheduler,
      nativeQueue: setup.ports.nativeQueue,
      contexts: setup.store,
      contextRuntime: setup.contextRuntime,
      activity: {
        observeRequestParticipants: async () => ({
          sourceVisible: true,
          targetVisible: true,
          targetStatus: "idle",
        }),
      },
      participantOperations: setup.ports.participantOperations,
      ownership: setup.store,
      clock: setup.ports.clock,
      ids: setup.ports.ids,
      digest: requestDigestPort,
    },
    {
      workspaceKey: requestTestWorkspace(),
      fencingToken: setup.token,
      invocationDeadlineMs: () => 90_000,
    },
    { message: "allow", ask: "allow", wait: "allow" },
  );
  const result = JSON.parse(
    await tool.execute(
      {
        session_id: setup.target,
        content: "Do the work.",
        request: { kind: "wait", milestone: "done", timeout_seconds: 30 },
      },
      { sessionID: setup.source, abort: new AbortController().signal },
    ),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { delivery_mode: "queue", delivery_state: "delivery_unknown" },
  });
  expect(
    await setup.store.listForParticipant({
      fencingToken: setup.token,
      workspaceKey: requestTestWorkspace(),
      callerSessionId: setup.source,
      role: "outbox",
      limit: 10,
    }),
  ).toMatchObject({ items: [{ deliveryMode: "queue", deliveryState: "delivery_unknown" }] });
  setup.store.close();
});

test("request-start retains one canonical initial user turn linked to the idempotent start", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  let approvals = 0;
  let initialCalls = 0;
  const tool = createSessionRequestStartTool(
    {
      readiness: { ...setup.ports.readiness, fencingToken: setup.token },
      membership: setup.ports.membership,
      starts: setup.store.starts,
      requests: setup.store,
      requestStarts: setup.store,
      scheduler: { wake: () => undefined },
      nativeStart: {
        createRootSession: async () => "created",
        reconcileRootSession: async () => "matching",
        updateSessionTitle: async () => "updated",
        admitInitialMessage: async ({ sessionId, message }) => {
          initialCalls += 1;
          const parsed = JSON.parse(message);
          expect(parsed.response.tool).toBe("session_signal");
          await setup.store.signalWait({
            fencingToken: setup.token,
            workspaceKey: requestTestWorkspace(),
            requestId: parsed.request_id,
            callerSessionId: sessionId,
            evidence: "done",
          });
          return "admitted";
        },
      },
      ownership: setup.store,
      clock: setup.ports.clock,
      ids: setup.ports.ids,
      digest: requestDigestPort,
      policy: createSessionStartPolicy({ decision: "allow" }),
    },
    {
      workspaceKey: requestTestWorkspace(),
      fencingToken: setup.token,
      invocationDeadlineMs: () => 90_000,
    },
    { ask: "allow", wait: "allow" },
  );
  const args = {
    idempotency_key: "release-notes",
    initial_message: "Build the release notes.",
    request: { kind: "wait" as const, milestone: "notes complete", timeout_seconds: 30 },
  };
  const context = {
    sessionID: setup.source,
    abort: new AbortController().signal,
    ask: async () => {
      approvals += 1;
    },
  };
  const first = JSON.parse(await tool.execute(args, context));
  expect(first).toMatchObject({
    ok: true,
    value: {
      request: { delivery_mode: "initial", resolution_state: "reached" },
      operation: { admission_state: "admitted" },
    },
  });
  const second = JSON.parse(await tool.execute(args, context));
  expect(second.value.operation.operation_id).toBe(first.value.operation.operation_id);
  expect(initialCalls).toBe(1);
  expect(approvals).toBe(0);
  setup.store.close();
});
