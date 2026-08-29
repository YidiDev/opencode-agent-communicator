import { afterEach, expect, test } from "bun:test";
import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
import { createSessionRequestSendTool } from "../../../src/tools/session-request-send";
import { createSessionRequestStartTool } from "../../../src/tools/session-request-start";
import {
  blockingRequestFixture,
  requestIdFromEnvelope,
} from "../../support/blocking-request-fixture";
import {
  cleanupRequestStoreRoots,
  requestDigestPort,
  requestTestWorkspace,
} from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test("request-send persists before one idle-capable queue effect and allows immediate completion", async () => {
  let calls = 0;
  let setup: Awaited<ReturnType<typeof blockingRequestFixture>>;
  setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const tool = createSessionRequestSendTool(
    {
      readiness: { ...setup.ports.readiness, fencingToken: setup.token },
      membership: setup.ports.membership,
      requests: setup.store,
      scheduler: { wake: () => undefined },
      nativeQueue: {
        queueMessage: async ({ envelope }) => {
          calls += 1;
          const requestId = requestIdFromEnvelope(envelope);
          expect(
            await setup.store.getRequestMetadata({
              fencingToken: setup.token,
              workspaceKey: requestTestWorkspace(),
              requestId: requestId as never,
            }),
          ).toBeDefined();
          await setup.store.answerAsk({
            fencingToken: setup.token,
            workspaceKey: requestTestWorkspace(),
            requestId: requestId as never,
            callerSessionId: setup.target,
            answers: [["done"]],
          });
          return { kind: "public_message", observedAtMs: 25_000 };
        },
      },
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
        request: {
          kind: "ask",
          questions: [{ prompt: "Result?", options: [], allow_custom: true }],
          timeout_seconds: 30,
        },
      },
      { sessionID: setup.source, abort: new AbortController().signal },
    ),
  );
  expect(calls).toBe(1);
  expect(result).toMatchObject({
    ok: true,
    value: { delivery_mode: "queue", resolution_state: "answered", result_state: "available" },
  });
});

test("request-send records queue ambiguity without replay", async () => {
  let calls = 0;
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const tool = createSessionRequestSendTool(
    {
      readiness: setup.ports.readiness,
      membership: setup.ports.membership,
      requests: setup.store,
      scheduler: { wake: () => undefined },
      nativeQueue: {
        queueMessage: async () => {
          calls += 1;
          return { kind: "unknown" };
        },
      },
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
        content: "Build it.",
        request: { kind: "wait", milestone: "built", timeout_seconds: 30 },
      },
      { sessionID: setup.source, abort: new AbortController().signal },
    ),
  );
  expect(calls).toBe(1);
  expect(result).toMatchObject({
    ok: true,
    value: {
      delivery_mode: "queue",
      delivery_state: "delivery_unknown",
      resolution_state: "pending",
    },
  });
});

test("request-start sends one canonical initial envelope linked to the idempotent start", async () => {
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
          expect(parsed.work.content).toBe("Build the release notes.");
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
      policy: createSessionStartPolicy({ decision: "ask" }),
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
  expect(first.value.request.linked_start_operation_id).toBe(first.value.operation.operation_id);
  const second = JSON.parse(await tool.execute(args, context));
  expect(second.value.operation.operation_id).toBe(first.value.operation.operation_id);
  expect(second.value.request.request_id).toBe(first.value.request.request_id);
  const conflict = JSON.parse(
    await tool.execute({ ...args, initial_message: "Build different release notes." }, context),
  );
  expect(conflict).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
  expect(initialCalls).toBe(1);
  expect(approvals).toBe(1);
});
