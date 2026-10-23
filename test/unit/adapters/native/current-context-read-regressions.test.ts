import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createOpenCode2NativeAdapter } from "../../../../src/adapters/native/opencode-2";
import { projectOpenCodeContext } from "../../../../src/adapters/native/opencode-context-projection";
import type { SessionId } from "../../../../src/domain/sessions";
import type { WorkspaceKey } from "../../../../src/domain/workspaces";

const workspace = "context-regression" as WorkspaceKey;
const target = "ses_target" as SessionId;
const snapshot = Array.from({ length: 12 }, (_, index) => ({
  id: `msg${index}`,
  type: "assistant",
  content: [
    { type: "reasoning", text: "omitted" },
    { type: "text", text: `answer ${index}` },
  ],
}));
const native = createOpenCode2NativeAdapter({
  context: { session: { context: () => Effect.succeed(snapshot) } } as never,
  directory: "/workspace",
  projectId: "project",
  workspaceKey: workspace,
});
const request = { workspaceKey: workspace, sessionId: target, abort: new AbortController().signal };

test("projects only the newest 512 entries without touching excluded prefix getters", () => {
  const context = Array.from({ length: 536 }, (_, index) => ({ id: `msg${index}`, type: "user" }));
  Object.defineProperty(context, 0, {
    get() {
      throw new Error("excluded entry accessed");
    },
  });
  const projected = projectOpenCodeContext(context);
  expect(projected.earlierContextUnavailable).toBe(true);
  expect(projected.examinedMessageCount).toBe(512);
  expect(projected.messages[0]?.messageId).toBe("msg24");
  expect(projected.messages.at(-1)?.messageId).toBe("msg535");
  expect(projectOpenCodeContext(snapshot).earlierContextUnavailable).toBe(false);
  // The same retained messages at a different window offset invalidate native cursors.
  expect(projectOpenCodeContext(context.slice(24)).snapshotSha256).not.toBe(
    projected.snapshotSha256,
  );
});

test("a host getter cannot extend projection work beyond the captured window", () => {
  const context: unknown[] = [{ id: "first", type: "user" }];
  Object.defineProperty(context, 0, {
    get() {
      context.push({ id: "unexpected", type: "user" });
      return { id: "first", type: "user" };
    },
  });
  expect(projectOpenCodeContext(context).examinedMessageCount).toBe(1);
});

test.each(["asc", "desc"] as const)("pages %s while charging each full snapshot", async (order) => {
  const first = await native.readMessagePage({ ...request, order });
  expect(first.rawResponseByteCount).toBe(projectOpenCodeContext(snapshot).serializedByteCount);
  expect(first.messages.map((message) => message.messageId)).toEqual(
    order === "asc"
      ? snapshot.slice(0, 8).map((message) => message.id)
      : snapshot
          .slice(4)
          .reverse()
          .map((message) => message.id),
  );
  if (!first.nextCursor) throw new Error("missing continuation");
  const next = await native.readMessagePage({ ...request, cursor: first.nextCursor });
  expect(next.rawResponseByteCount).toBe(first.rawResponseByteCount);
  expect(next.messages.map((message) => message.messageId)).toEqual(
    order === "asc"
      ? snapshot.slice(8).map((message) => message.id)
      : snapshot
          .slice(0, 4)
          .reverse()
          .map((message) => message.id),
  );
  expect(next.nextCursor).toBeNull();
  for (const messageId of ["msg0", "missing"]) {
    const result = await native.readMessage({ ...request, messageId });
    expect(result.rawResponseByteCount).toBe(first.rawResponseByteCount);
    await expect(
      native.readMessage({
        ...request,
        messageId,
        maximumResponseBytes: first.rawResponseByteCount - 1,
      }),
    ).rejects.toThrow("projection bound");
  }
  await expect(
    native.readMessagePage({
      ...request,
      order,
      maximumResponseBytes: first.rawResponseByteCount - 1,
    }),
  ).rejects.toThrow("projection bound");
});

test("projection never traverses ignored host fields", () => {
  const ignored = {
    get text(): never {
      throw new Error("must not inspect ignored content");
    },
  };
  expect(
    projectOpenCodeContext([
      { id: "user", type: "user", content: ignored },
      {
        id: "assistant",
        type: "assistant",
        providerState: ignored,
        content: [
          {
            type: "reasoning",
            get text(): never {
              throw new Error("must not inspect reasoning");
            },
          },
          {
            type: "tool",
            id: "tool",
            name: "read",
            state: { status: "completed", input: ignored, content: ignored },
          },
        ],
      },
    ]).messages,
  ).toHaveLength(2);
});
