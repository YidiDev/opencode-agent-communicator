import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  projectOpenCodeContext,
  readOpenCodeContextProjection,
} from "../../../../src/adapters/native/opencode-context-projection";
import { sessionReadLimits } from "../../../../src/domain/session-read";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("Invalid fixture.");
  return result.value;
}

describe("OpenCode v2 current-context projection", () => {
  test("retains only assistant text and bounded tool status", () => {
    const projected = projectOpenCodeContext([
      { id: "msg_user", type: "user", text: "secret user text", files: ["secret"] },
      {
        id: "msg_assistant",
        type: "assistant",
        metadata: { secret: true },
        providerState: { secret: true },
        time: { completed: 2 },
        content: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: "safe answer", state: { private: true } },
          {
            type: "tool",
            id: "tool_1",
            name: "bash",
            state: { status: "completed", input: { secret: true }, content: [{ text: "secret" }] },
            providerState: { secret: true },
          },
        ],
      },
    ]);
    expect(projected.messages).toEqual([
      { type: "user", messageId: "msg_user" },
      {
        type: "assistant",
        messageId: "msg_assistant",
        state: "completed",
        parts: [
          { type: "text", itemKey: "text:1", text: "safe answer" },
          { type: "tool", itemKey: "tool_1", name: "bash", status: "completed" },
        ],
      },
    ]);
    const serialized = JSON.stringify(projected);
    for (const secret of ["secret user text", "private reasoning", "private", "providerState"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("fails closed on duplicate identities and malformed tool state", () => {
    expect(() =>
      projectOpenCodeContext([
        { id: "msg_same", type: "user" },
        { id: "msg_same", type: "user" },
      ]),
    ).toThrow("message identity");
    expect(() =>
      projectOpenCodeContext([
        {
          id: "msg_assistant",
          type: "assistant",
          content: [{ type: "tool", id: "tool_1", name: "bash", state: { status: "future" } }],
        },
      ]),
    ).toThrow("tool state");
  });

  test("projects all assistant states and supported tool statuses", () => {
    const projected = projectOpenCodeContext([
      {
        id: "active",
        type: "assistant",
        content: [
          { type: "tool", id: "pending", name: "read", state: { status: "streaming" } },
          { type: "tool", id: "running", name: "read", state: { status: "running" } },
        ],
      },
      {
        id: "failed",
        type: "assistant",
        error: {},
        time: { completed: 1 },
        content: [{ type: "tool", id: "error", name: "bash", state: { status: "error" } }],
      },
      { id: "ignored", type: "system", content: "private" },
    ]);

    expect(projected.messages).toEqual([
      {
        type: "assistant",
        messageId: "active",
        state: "active",
        parts: [
          { type: "tool", itemKey: "pending", name: "read", status: "pending" },
          { type: "tool", itemKey: "running", name: "read", status: "running" },
        ],
      },
      {
        type: "assistant",
        messageId: "failed",
        state: "error",
        parts: [{ type: "tool", itemKey: "error", name: "bash", status: "error" }],
      },
    ]);
    expect(projected).toMatchObject({
      examinedMessageIds: ["active", "failed", "ignored"],
      examinedMessageCount: 3,
      examinedPartCount: 3,
      projectedTextByteCount: 0,
    });
  });
});

describe("OpenCode v2 current-context projection validation", () => {
  test("rejects malformed message, assistant, text, and tool shapes", () => {
    const malformed: readonly [unknown, string][] = [
      [null, "message identity"],
      [[{ id: "array-message" }], "message identity"],
      [{ id: "", type: "user" }, "message identity"],
      [{ id: "space id", type: "user" }, "message identity"],
      [
        { id: "x".repeat(sessionReadLimits.maxNativeCursorCharacters + 1), type: "user" },
        "message identity",
      ],
      [{ id: "assistant", type: "assistant" }, "assistant content"],
      [{ id: "assistant", type: "assistant", content: "not-an-array" }, "assistant content"],
      [
        { id: "assistant", type: "assistant", content: [{ type: "text", text: 1 }] },
        "assistant text",
      ],
      [
        {
          id: "assistant",
          type: "assistant",
          content: [
            { type: "text", text: "x".repeat(sessionReadLimits.maxNativeTextCharacters + 1) },
          ],
        },
        "assistant text",
      ],
      [
        {
          id: "assistant",
          type: "assistant",
          content: [{ type: "tool", id: "", name: "bash", state: { status: "running" } }],
        },
        "tool state",
      ],
      [
        {
          id: "assistant",
          type: "assistant",
          content: [{ type: "tool", id: "tool", name: [], state: { status: "running" } }],
        },
        "tool state",
      ],
      [
        {
          id: "assistant",
          type: "assistant",
          content: [{ type: "tool", id: "tool", name: "bash", state: null }],
        },
        "tool state",
      ],
    ];
    for (const [candidate, message] of malformed) {
      expect(() => projectOpenCodeContext([candidate])).toThrow(message);
    }
    expect(() => projectOpenCodeContext({})).toThrow("message bound");
    expect(() =>
      projectOpenCodeContext(Array.from({ length: sessionReadLimits.maxMessagesExamined + 1 })),
    ).toThrow("message bound");
    expect(() =>
      projectOpenCodeContext([
        {
          id: "assistant",
          type: "assistant",
          content: Array.from({ length: sessionReadLimits.maxNativeAssistantParts + 1 }),
        },
      ]),
    ).toThrow("assistant content");
  });

  test("enforces aggregate part and UTF-8 text byte bounds", () => {
    const fullParts = Array.from({ length: sessionReadLimits.maxNativeAssistantParts }, () => ({
      type: "reasoning",
    }));
    expect(() =>
      projectOpenCodeContext([
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `assistant-${index}`,
          type: "assistant",
          content: fullParts,
        })),
        { id: "overflow", type: "assistant", content: [{ type: "reasoning" }] },
      ]),
    ).toThrow("part bound");

    const megabyte = "é".repeat(sessionReadLimits.maxNativeTextCharacters);
    expect(() =>
      projectOpenCodeContext([
        {
          id: "assistant",
          type: "assistant",
          content: Array.from({ length: 5 }, () => ({ type: "text", text: megabyte })),
        },
      ]),
    ).toThrow("text bound");

    const escapedMegabyte = "\0".repeat(sessionReadLimits.maxNativeTextCharacters);
    expect(() =>
      projectOpenCodeContext([
        {
          id: "assistant",
          type: "assistant",
          content: Array.from({ length: 8 }, () => ({ type: "text", text: escapedMegabyte })),
        },
      ]),
    ).toThrow("serialized bound");
  });
});

describe("OpenCode v2 current-context projection host reads", () => {
  test("validates projection bindings and preserves host failures", async () => {
    const workspace = valid(validateWorkspaceKey("wrk_projection"));
    const otherWorkspace = valid(validateWorkspaceKey("wrk_other"));
    const sessionId = valid(validateSessionId("ses_projection"));
    const successful = { context: () => Effect.succeed([]) as never };

    await expect(
      readOpenCodeContextProjection(successful, otherWorkspace, workspace, sessionId),
    ).rejects.toThrow("binding");
    await expect(
      readOpenCodeContextProjection(successful, workspace, workspace, "bad id" as typeof sessionId),
    ).rejects.toThrow("binding");
    expect(
      await readOpenCodeContextProjection(successful, workspace, workspace, sessionId),
    ).toMatchObject({ messages: [], examinedMessageCount: 0 });

    const failed = { context: () => Effect.fail(new Error("host unavailable")) as never };
    await expect(
      readOpenCodeContextProjection(failed, workspace, workspace, sessionId),
    ).rejects.toThrow("host unavailable");

    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      readOpenCodeContextProjection(successful, workspace, workspace, sessionId, abort.signal),
    ).rejects.toThrow("cancelled");
  });
});
