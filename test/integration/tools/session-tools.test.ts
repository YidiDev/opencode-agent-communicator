import { describe, expect, test } from "bun:test";

import type { DeliveryPersistencePort } from "../../../src/application/delivery-ports";
import type { SessionSendPorts } from "../../../src/application/send-session-message";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { createSessionDeliveryGetTool } from "../../../src/tools/session-delivery-get";
import { createSessionListTool } from "../../../src/tools/session-list";
import { createSessionSendTool } from "../../../src/tools/session-send";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:one"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const abort = new AbortController().signal;

function unusedDeliveries(): DeliveryPersistencePort {
  return {
    async createPrepared() {
      throw new Error("not used");
    },
    async cancelPrepared() {
      throw new Error("not used");
    },
    async claimPrepared() {
      throw new Error("not used");
    },
    async completeSubmission() {
      throw new Error("not used");
    },
    async listRecoverable() {
      return [];
    },
    async getForParticipant() {
      return undefined;
    },
  };
}

describe("internal session tools call application boundaries", () => {
  test("list emits exact snake_case JSON and teaches the queue workflow", async () => {
    const tool = createSessionListTool(
      {
        membership: {
          async readCurrentRoots() {
            return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
          },
        },
        sessions: {
          async readVisibleRoots() {
            return [
              {
                id: valid(validateSessionId("ses_target")),
                title: "Target",
                status: "busy",
                isArchived: false,
                updatedAtMs: 5,
                observedAtMs: 6,
              },
            ];
          },
        },
      },
      workspaceKey,
    );
    const output = JSON.parse(
      await tool.execute({ status: "active" }, { sessionID: "ses_source", abort }),
    );
    expect(output).toEqual({
      ok: true,
      value: [
        {
          session_id: "ses_target",
          title: "Target",
          status: "busy",
          is_active: true,
          is_archived: false,
          updated_at_ms: 5,
          status_observed_at_ms: 6,
        },
      ],
    });
    expect(tool.description).toContain("session_send");
    expect(tool.description).toContain("ask or wait");
  });

  test("delivery get preserves hidden lookup and declared application failures as JSON", async () => {
    const tool = createSessionDeliveryGetTool(
      {
        membership: {
          async readCurrentRoots() {
            return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
          },
        },
        deliveries: unusedDeliveries(),
      },
      workspaceKey,
    );
    const output = JSON.parse(
      await tool.execute(
        { delivery_id: `dlv_${"a".repeat(32)}` },
        { sessionID: sourceSessionId, abort },
      ),
    );
    expect(output).toMatchObject({
      ok: false,
      error: { code: "not_found_or_unauthorized", retryable: false },
    });
  });

  test("send validates structural context and returns expected domain failure without throwing", async () => {
    const ports = { deliveries: unusedDeliveries() } as unknown as SessionSendPorts;
    const tool = createSessionSendTool(ports, workspaceKey);
    const output = JSON.parse(
      await tool.execute(
        { session_id: "ses_target", content: "hello" },
        { sessionID: "foreign", abort },
      ),
    );
    expect(output).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    const applicationOutput = JSON.parse(
      await tool.execute(
        { session_id: "foreign", content: "hello" },
        { sessionID: sourceSessionId, abort },
      ),
    );
    expect(applicationOutput).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(tool.description).toContain("does not prove activation");
    expect(tool.description).toContain("session_list");
  });
});
