import { expect, test } from "bun:test";

import type { ParticipantRequestMetadata } from "../../../src/application/request-ports";
import { validateRequestId } from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { createSessionRequestListTool } from "../../../src/tools/session-request-list";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
}

test("serializes a repository continuation as the public next_cursor", async () => {
  const workspaceKey = valid(validateWorkspaceKey("workspace:list-tool-cursor"));
  const fencingToken = valid(validateFencingToken(1));
  const source = valid(validateSessionId("ses_source"));
  const target = valid(validateSessionId("ses_target"));
  const requestId = valid(validateRequestId(`req_${"d".repeat(32)}`));
  const metadata: ParticipantRequestMetadata<"source"> = {
    requestId,
    participantRole: "source",
    kind: "wait",
    resolutionState: "pending",
    deliveryState: "admitted",
    resultState: "none",
    sourceSessionId: source,
    targetSessionId: target,
    createdAtMs: 10,
    updatedAtMs: 11,
    deadlineAtMs: 20,
    submittedAtMs: 10,
    admittedAtMs: 11,
  };
  const tool = createSessionRequestListTool(
    {
      readiness: { assertReady() {} },
      membership: {
        async readCurrentRoots() {
          return { sourceTitle: "Source", sourceVisible: true, targetVisible: true };
        },
      },
      requests: {
        async listForParticipant() {
          return { items: [metadata], hasMore: true, terminalized: [] };
        },
        async getParticipantRequest() {
          throw new Error("not used");
        },
      },
      notifications: { notifyTerminal: () => undefined },
    },
    { workspaceKey, fencingToken, invocationDeadlineMs: () => Date.now() + 10_000 },
  );

  const output = JSON.parse(
    await tool.execute(
      { role: "outbox", limit: 1 },
      { sessionID: source, abort: new AbortController().signal },
    ),
  );

  expect(output).toMatchObject({
    ok: true,
    value: { items: [{ request_id: requestId, role: "source" }] },
  });
  expect(output.value.next_cursor).toBeString();
});
