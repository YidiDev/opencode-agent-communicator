import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { createOpenCode2NativeAdapter } from "../../../src/adapters/native/opencode-2";
import type { SessionReadPorts } from "../../../src/application/session-read-ports";
import type { WorkspaceKey } from "../../../src/domain/workspaces";
import { createSessionReadTool } from "../../../src/tools/session-read";

test("long-session public reads disclose truncation and keep cursor traversal inside the tail", async () => {
  const workspaceKey = "long-context" as WorkspaceKey;
  let snapshot = Array.from({ length: 536 }, (_, index) => ({ id: `msg${index}`, type: "user" }));
  const native = createOpenCode2NativeAdapter({
    context: { session: { context: () => Effect.succeed(snapshot) } } as never,
    directory: "/workspace",
    projectId: "project",
    workspaceKey,
  });
  const ports: Omit<SessionReadPorts, "approval"> = {
    readiness: { assertReady: () => undefined },
    native,
    membership: {
      observeSessionReadPresence: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "unknown",
        observedAtMs: 1,
      }),
    },
    digest: {
      sha256: async (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()),
    },
    clock: { nowMs: () => 1_000 },
    timer: { arm: () => ({ cancel: () => undefined }) },
  };
  const tool = createSessionReadTool(ports, { workspaceKey, invocationDeadlineMs: () => 2_000 });
  const context = { sessionID: "ses_source", abort: new AbortController().signal };
  const invoke = async (args: Record<string, unknown>) =>
    JSON.parse(
      await tool.execute({ session_id: "ses_source", limit: 1, ...args } as never, context),
    );
  const tail = await invoke({});
  expect(tail).toMatchObject({
    ok: true,
    value: {
      content: "[user message omitted]",
      earlier_context_unavailable: true,
      has_more_before: true,
      is_live: false,
    },
  });
  const after = await invoke({ cursor: tail.value.end_cursor, direction: "after" });
  expect(after).toMatchObject({
    ok: true,
    value: { content: "", earlier_context_unavailable: true, has_more_after: false },
  });
  const wholeWindow = await invoke({ limit: 500 });
  expect(wholeWindow.ok).toBe(true);
  const first = await invoke({
    cursor: wholeWindow.value.start_cursor,
    direction: "before",
    limit: 100,
  });
  // Fixed-anchor validation plus a full 512-entry walk still exceeds the unchanged work budget.
  expect(first).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
  snapshot = snapshot.map((message, index) => ({
    ...message,
    type: index < 534 ? "system" : "user",
  }));
  const window = await invoke({ limit: 100 });
  expect(window).toMatchObject({
    ok: true,
    value: { earlier_context_unavailable: true, has_more_before: false },
  });
  expect(window.value.content.split("\n")).toHaveLength(2);
  const outside = await invoke({ cursor: window.value.start_cursor, direction: "before" });
  expect(outside).toMatchObject({
    ok: true,
    value: { content: "", earlier_context_unavailable: true, has_more_before: false },
  });
  // Moving the retained window past the anchor must not guess a continuation.
  snapshot = Array.from({ length: 1_100 }, (_, index) => ({ id: `msg${index}`, type: "user" }));
  expect(await invoke({ cursor: tail.value.end_cursor })).toMatchObject({
    ok: false,
    error: { code: "cursor_stale" },
  });
  ports.membership.observeSessionReadPresence = async () => ({
    sourceVisible: true,
    targetVisible: false,
    targetStatus: "unknown",
    observedAtMs: 2,
  });
  expect(await invoke({})).toMatchObject({ ok: false, error: { code: "target_not_visible" } });
});
