import { describe, expect, test } from "bun:test";

import { validateDeliveryId, validateRequestId } from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { createSessionDeliveryGetTool } from "../../../src/tools/session-delivery-get";
import { createSessionListTool } from "../../../src/tools/session-list";
import { createSessionRequestAckTool } from "../../../src/tools/session-request-ack";
import { createSessionRequestCancelTool } from "../../../src/tools/session-request-cancel";
import { createSessionRequestGetTool } from "../../../src/tools/session-request-get";
import { createSessionRequestListTool } from "../../../src/tools/session-request-list";
import { createSessionRespondTool } from "../../../src/tools/session-respond";
import { createSessionSendTool } from "../../../src/tools/session-send";
import { createSessionSignalTool } from "../../../src/tools/session-signal";
import { createSessionStartTool } from "../../../src/tools/session-start";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:finite-io-tools"));
const fencingToken = value(validateFencingToken(9));
const deliveryId = value(validateDeliveryId(`dlv_${"4".repeat(32)}`));
const requestId = value(validateRequestId(`req_${"5".repeat(32)}`));
const context = { sessionID: "ses_caller", abort: new AbortController().signal };
const never = async (): Promise<never> => new Promise(() => undefined);
const deadline = () => Date.now() + 15;
const readiness = { assertReady() {} };
const membership = { readCurrentRoots: never };
const visibleMembership = {
  async readCurrentRoots() {
    return { sourceTitle: "Caller", sourceVisible: true, targetVisible: true };
  },
};

describe("finite tool invocation I/O", () => {
  test("bounds session_list native query I/O", async () => {
    const tool = createSessionListTool(
      { readiness, membership: visibleMembership, sessions: { readVisibleRoots: never } },
      workspaceKey,
      deadline,
    );
    expect(JSON.parse(await tool.execute({}, context))).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
  });

  test("bounds session_send membership I/O before durable admission", async () => {
    const tool = createSessionSendTool(
      { readiness, membership } as never,
      workspaceKey,
      "allow",
      deadline,
    );
    expect(
      JSON.parse(await tool.execute({ session_id: "ses_target", content: "work" }, context)),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
  });

  test("bounds session_delivery_get persistence query I/O", async () => {
    const tool = createSessionDeliveryGetTool(
      {
        readiness,
        membership: visibleMembership,
        deliveries: { getForParticipant: never } as never,
      },
      workspaceKey,
      deadline,
    );
    expect(JSON.parse(await tool.execute({ delivery_id: deliveryId }, context))).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
  });

  test("bounds session_request_list participant query I/O", async () => {
    const tool = createSessionRequestListTool(
      {
        readiness,
        membership: visibleMembership,
        requests: { listForParticipant: never },
      } as never,
      { workspaceKey, fencingToken, invocationDeadlineMs: deadline },
    );
    expect(JSON.parse(await tool.execute({}, context))).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
  });

  test("bounds session_request_get participant query I/O", async () => {
    const tool = createSessionRequestGetTool(
      {
        readiness,
        membership: visibleMembership,
        requests: { getParticipantRequest: never },
      } as never,
      { workspaceKey, fencingToken, invocationDeadlineMs: deadline },
    );
    expect(JSON.parse(await tool.execute({ request_id: requestId }, context))).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
  });

  test("bounds session_start membership I/O", async () => {
    const tool = createSessionStartTool(
      { readiness, membership, clock: { nowMs: Date.now } } as never,
      { workspaceKey, invocationDeadlineMs: deadline },
    );
    expect(
      JSON.parse(
        await tool.execute(
          { idempotency_key: "finite:start", initial_message: "work" },
          { ...context, ask: async () => undefined },
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
  });

  test("bounds request-mutation membership I/O", async () => {
    const ports = {
      readiness,
      membership,
      clock: { nowMs: Date.now },
      digest: { sha256: async () => new Uint8Array(32) },
    } as never;
    const scope = { workspaceKey, fencingToken, invocationDeadlineMs: deadline };
    const invocations = [
      createSessionRespondTool(ports, scope).execute(
        { request_id: requestId, answers: [["yes"]] },
        context,
      ),
      createSessionSignalTool(ports, scope).execute({ request_id: requestId }, context),
      createSessionRequestAckTool(ports, scope).execute({ request_id: requestId }, context),
      createSessionRequestCancelTool(ports, scope).execute({ request_id: requestId }, context),
    ];
    for (const invocation of invocations) {
      expect(JSON.parse(await invocation)).toMatchObject({
        ok: false,
        error: { code: "deadline_expired" },
      });
    }
  });

  test("structures pre-aborted and already-elapsed request mutations", async () => {
    const ports = {
      readiness,
      membership: visibleMembership,
      clock: { nowMs: Date.now },
      digest: { sha256: async () => new Uint8Array(32) },
    } as never;
    const aborted = new AbortController();
    aborted.abort();
    for (const control of [
      { abort: aborted.signal, invocationDeadlineMs: () => Date.now() + 1_000 },
      { abort: context.abort, invocationDeadlineMs: () => 0 },
    ]) {
      const scope = {
        workspaceKey,
        fencingToken,
        invocationDeadlineMs: control.invocationDeadlineMs,
      };
      const toolContext = { ...context, abort: control.abort };
      const invocations = [
        createSessionRespondTool(ports, scope).execute(
          { request_id: requestId, answers: [["yes"]] },
          toolContext,
        ),
        createSessionSignalTool(ports, scope).execute({ request_id: requestId }, toolContext),
        createSessionRequestAckTool(ports, scope).execute({ request_id: requestId }, toolContext),
        createSessionRequestCancelTool(ports, scope).execute(
          { request_id: requestId },
          toolContext,
        ),
      ];
      for (const invocation of invocations) {
        expect(JSON.parse(await invocation)).toMatchObject({
          ok: false,
          error: { code: "deadline_expired" },
        });
      }
    }
  });
});
