import { describe, expect, test } from "bun:test";

import { validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { createSessionAskTool } from "../../../src/tools/session-ask";
import { createSessionDeliveryGetTool } from "../../../src/tools/session-delivery-get";
import { createSessionExportTool } from "../../../src/tools/session-export";
import { createSessionListTool } from "../../../src/tools/session-list";
import { createSessionRequestAckTool } from "../../../src/tools/session-request-ack";
import { createSessionRequestCancelTool } from "../../../src/tools/session-request-cancel";
import { createSessionRequestGetTool } from "../../../src/tools/session-request-get";
import { createSessionRequestListTool } from "../../../src/tools/session-request-list";
import { createSessionRespondTool } from "../../../src/tools/session-respond";
import { createSessionSendTool } from "../../../src/tools/session-send";
import { createSessionSignalTool } from "../../../src/tools/session-signal";
import { createSessionStopTool } from "../../../src/tools/session-stop";
import { createSessionWaitTool } from "../../../src/tools/session-wait";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:tool-boundaries"));
const fencingToken = value(validateFencingToken(1));
const abort = new AbortController().signal;
const invalidContext = { sessionID: "invalid", abort };
const requestScope = { workspaceKey, fencingToken, invocationDeadlineMs: () => 100 };

describe("session tool boundaries", () => {
  test("serializes malformed caller identity without entering application ports", async () => {
    const tools = [
      [createSessionAskTool({} as never, requestScope), {}],
      [createSessionDeliveryGetTool({} as never, workspaceKey), {}],
      [createSessionRequestAckTool({} as never, requestScope), {}],
      [createSessionRequestCancelTool({} as never, requestScope), {}],
      [createSessionRequestGetTool({} as never, requestScope), {}],
      [createSessionRequestListTool({} as never, requestScope), {}],
      [createSessionRespondTool({} as never, requestScope), {}],
      [createSessionSignalTool({} as never, requestScope), {}],
      [createSessionWaitTool({} as never, requestScope), {}],
      [createSessionSendTool({} as never, workspaceKey), {}],
      [createSessionStopTool({} as never, workspaceKey), {}],
      [
        createSessionExportTool({} as never, {
          workspaceKey,
          invocationDeadlineMs: () => 100,
        }),
        {},
      ],
    ] as const;
    for (const [tool, arguments_] of tools) {
      const output = JSON.parse(await tool.execute(arguments_ as never, invalidContext));
      expect(output).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    }
  });

  test("rejects invalid optional tool deadlines before application effects", async () => {
    for (const deadline of [Number.NaN, 0]) {
      await expect(
        createSessionSendTool({} as never, workspaceKey, "allow", () => deadline).execute(
          {} as never,
          invalidContext,
        ),
      ).rejects.toThrow("deadline");
      await expect(
        createSessionStopTool({} as never, workspaceKey, () => deadline).execute(
          {} as never,
          invalidContext,
        ),
      ).rejects.toThrow("deadline");
    }
    await expect(
      createSessionExportTool({} as never, {
        workspaceKey,
        invocationDeadlineMs: () => {
          throw new Error("clock");
        },
      }).execute({} as never, invalidContext),
    ).rejects.toThrow();
  });

  test("maps every session-list optional argument at the tool boundary", async () => {
    const captured: boolean[] = [];
    const tool = createSessionListTool(
      {
        readiness: { assertReady() {} },
        membership: {
          async readCurrentRoots() {
            return { sourceVisible: true, targetVisible: true, sourceTitle: "source" };
          },
        },
        sessions: {
          async readVisibleRoots(includeArchived) {
            captured.push(includeArchived);
            return [];
          },
        },
      },
      workspaceKey,
    );
    await tool.execute({}, { sessionID: "ses_source", abort });
    await tool.execute(
      { status: "all", include_archived: false, limit: 1 },
      { sessionID: "ses_source", abort },
    );
    expect(captured).toEqual([false, false]);
  });
});
