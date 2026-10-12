import { afterEach, expect, test } from "bun:test";
import { blockingRequestDeadlineMarginMs } from "../../../src/domain/request-constants";
import { createSessionAskTool } from "../../../src/tools/session-ask";
import { createSessionRequestAckTool } from "../../../src/tools/session-request-ack";
import { createSessionRequestCancelTool } from "../../../src/tools/session-request-cancel";
import { createSessionRequestGetTool } from "../../../src/tools/session-request-get";
import { createSessionRequestListTool } from "../../../src/tools/session-request-list";
import { createSessionRespondTool } from "../../../src/tools/session-respond";
import { createSessionSignalTool } from "../../../src/tools/session-signal";
import { createSessionWaitTool } from "../../../src/tools/session-wait";
import {
  blockingRequestFixture,
  deferred,
  requestIdFromEnvelope,
} from "../../support/blocking-request-fixture";
import { cleanupRequestStoreRoots, requestTestWorkspace } from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

const abort = new AbortController().signal;

function toolContext(sessionID: string) {
  return { sessionID, abort };
}

test("ask tool protocol exposes inbox payload, response, result, and acknowledgement", async () => {
  const queued = deferred<string>();
  const setup = await blockingRequestFixture(async ({ envelope }) => {
    queued.resolve(envelope);
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  const scope = {
    workspaceKey: requestTestWorkspace(),
    fencingToken: setup.token,
    invocationDeadlineMs: (minimumDurationMs?: number) =>
      minimumDurationMs === undefined ? Date.now() + 90_000 : 90_000,
  };
  const ask = createSessionAskTool(setup.ports, scope);
  const blocked = ask.execute(
    {
      session_id: setup.target,
      questions: [{ prompt: "Ship?", options: ["yes", "no"] }],
      timeout_seconds: 30,
    },
    toolContext(setup.source),
  );
  const requestId = requestIdFromEnvelope(await queued.promise);

  const list = createSessionRequestListTool(
    {
      readiness: setup.ports.readiness,
      membership: setup.ports.membership,
      requests: setup.store,
      notifications: setup.runtime,
    },
    scope,
  );
  const inbox = JSON.parse(await list.execute({ role: "inbox" }, toolContext(setup.target)));
  expect(inbox).toMatchObject({
    ok: true,
    value: {
      items: [
        {
          request_id: requestId,
          role: "target",
          kind: "ask",
          resolution_state: "pending",
        },
      ],
    },
  });
  expect(JSON.stringify(inbox)).not.toContain("Ship?");

  const get = createSessionRequestGetTool(
    {
      readiness: setup.ports.readiness,
      membership: setup.ports.membership,
      requests: setup.store,
      notifications: setup.runtime,
    },
    scope,
  );
  expect(
    JSON.parse(await get.execute({ request_id: requestId }, toolContext(setup.target))),
  ).toMatchObject({
    ok: true,
    value: {
      outcome: "pending_payload",
      payload: {
        kind: "ask",
        questions: [{ prompt: "Ship?", options: ["yes", "no"], allow_custom: false }],
        timeout_seconds: 30,
      },
    },
  });
  expect(
    JSON.parse(await get.execute({ request_id: requestId }, toolContext(setup.source))),
  ).toMatchObject({
    ok: true,
    value: { outcome: "metadata", view: "source_pending", metadata: { role: "source" } },
  });
  expect(await get.execute({ request_id: requestId }, toolContext(setup.source))).not.toContain(
    "Ship?",
  );
  expect(
    JSON.parse(await get.execute({ request_id: requestId }, toolContext("ses_foreign"))),
  ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });

  const ack = createSessionRequestAckTool(setup.mutationPorts, scope);
  const cancel = createSessionRequestCancelTool(setup.mutationPorts, scope);
  expect(
    JSON.parse(await ack.execute({ request_id: requestId }, toolContext("ses_foreign"))),
  ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });
  expect(
    JSON.parse(await cancel.execute({ request_id: requestId }, toolContext("ses_foreign"))),
  ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });

  const respond = createSessionRespondTool(setup.mutationPorts, scope);
  expect(
    JSON.parse(
      await respond.execute(
        { request_id: requestId, answers: [["yes"]] },
        toolContext(setup.target),
      ),
    ),
  ).toMatchObject({ ok: true, value: { request_id: requestId, state: "answered" } });
  expect(JSON.parse(await blocked)).toEqual({
    ok: true,
    value: { request_id: requestId, state: "answered", answers: [["yes"]] },
  });

  expect(
    JSON.parse(await get.execute({ request_id: requestId }, toolContext(setup.source))),
  ).toMatchObject({
    ok: true,
    value: {
      outcome: "available_result",
      metadata: { role: "source", result_state: "available" },
      result: { kind: "ask", answers: [["yes"]] },
    },
  });
  const terminalOutbox = JSON.parse(
    await list.execute({ role: "outbox" }, toolContext(setup.source)),
  );
  expect(terminalOutbox).toMatchObject({
    ok: true,
    value: { items: [{ request_id: requestId, result_state: "available" }] },
  });
  expect(JSON.stringify(terminalOutbox)).not.toContain("yes");
  expect(
    JSON.parse(await ack.execute({ request_id: requestId }, toolContext(setup.source))),
  ).toMatchObject({ ok: true, value: { request_id: requestId, state: "acknowledged" } });
  expect(
    JSON.parse(await ack.execute({ request_id: requestId }, toolContext(setup.source))),
  ).toMatchObject({ ok: true, value: { request_id: requestId, state: "acknowledged" } });
  expect(
    JSON.parse(await get.execute({ request_id: requestId }, toolContext(setup.source))),
  ).toMatchObject({ ok: false, error: { code: "result_expired" } });
  setup.store.close();
});

test("wait and signal tools complete with bounded evidence", async () => {
  const queued = deferred<string>();
  const setup = await blockingRequestFixture(async ({ envelope }) => {
    queued.resolve(envelope);
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  const scope = {
    workspaceKey: requestTestWorkspace(),
    fencingToken: setup.token,
    invocationDeadlineMs: () => 90_000,
  };
  const wait = createSessionWaitTool(setup.ports, scope);
  const blocked = wait.execute(
    { session_id: setup.target, milestone: "compiled", timeout_seconds: 30 },
    toolContext(setup.source),
  );
  const requestId = requestIdFromEnvelope(await queued.promise);
  const respond = createSessionRespondTool(setup.mutationPorts, scope);
  expect(
    JSON.parse(
      await respond.execute({ request_id: requestId, answers: [[]] }, toolContext(setup.target)),
    ),
  ).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  const signal = createSessionSignalTool(setup.mutationPorts, scope);
  expect(
    JSON.parse(
      await signal.execute(
        { request_id: requestId, evidence: "artifact://build" },
        toolContext(setup.target),
      ),
    ),
  ).toMatchObject({ ok: true, value: { request_id: requestId, state: "reached" } });
  expect(JSON.parse(await blocked)).toEqual({
    ok: true,
    value: { request_id: requestId, state: "reached", evidence: "artifact://build" },
  });
  setup.store.close();
});

test("maximum wait keeps the persisted request deadline ahead of invocation cancellation", async () => {
  const queued = deferred<string>();
  const setup = await blockingRequestFixture(async ({ envelope }) => {
    queued.resolve(envelope);
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  let requestedMinimumDurationMs: number | undefined;
  const wait = createSessionWaitTool(setup.ports, {
    workspaceKey: requestTestWorkspace(),
    fencingToken: setup.token,
    invocationDeadlineMs: (minimumDurationMs) => {
      requestedMinimumDurationMs = minimumDurationMs;
      if (minimumDurationMs === undefined) throw new Error("missing blocking minimum");
      return 25_000 + minimumDurationMs;
    },
  });
  const controller = new AbortController();
  const blocked = wait.execute(
    { session_id: setup.target, milestone: "maximum", timeout_seconds: 3_600 },
    { sessionID: setup.source, abort: controller.signal },
  );
  const envelope = JSON.parse(await queued.promise);

  expect(requestedMinimumDurationMs).toBe(3_600_000 + blockingRequestDeadlineMarginMs * 2);
  expect(envelope.deadline_at_ms).toBe(25_000 + 3_600_000);
  expect(25_000 + (requestedMinimumDurationMs as number) - envelope.deadline_at_ms).toBe(
    blockingRequestDeadlineMarginMs * 2,
  );
  expect(controller.signal.aborted).toBe(false);

  controller.abort("explicit_test_cancellation");
  expect(JSON.parse(await blocked)).toMatchObject({
    ok: false,
    error: { code: "request_cancelled" },
  });
  setup.store.close();
});

test("cancel tool terminalizes a pending wait and releases the blocked source", async () => {
  const queued = deferred<string>();
  const setup = await blockingRequestFixture(async ({ envelope }) => {
    queued.resolve(envelope);
    return { kind: "public_message", observedAtMs: 25_000 };
  });
  const scope = {
    workspaceKey: requestTestWorkspace(),
    fencingToken: setup.token,
    invocationDeadlineMs: () => 90_000,
  };
  const wait = createSessionWaitTool(setup.ports, scope);
  const blocked = wait.execute(
    { session_id: setup.target, milestone: "publish", timeout_seconds: 30 },
    toolContext(setup.source),
  );
  const requestId = requestIdFromEnvelope(await queued.promise);
  const cancel = createSessionRequestCancelTool(setup.mutationPorts, scope);
  expect(
    JSON.parse(await cancel.execute({ request_id: requestId }, toolContext(setup.source))),
  ).toMatchObject({ ok: true, value: { request_id: requestId, state: "cancelled" } });
  expect(
    JSON.parse(await cancel.execute({ request_id: requestId }, toolContext(setup.source))),
  ).toMatchObject({ ok: true, value: { request_id: requestId, state: "cancelled" } });
  expect(JSON.parse(await blocked)).toMatchObject({
    ok: false,
    error: { code: "request_cancelled" },
  });
  setup.store.close();
});
