import { describe, expect, test } from "bun:test";
import { sessionReadLimits } from "../../../src/domain/session-read";
import {
  packProjectionLines,
  projectSessionMessage,
  projectSessionMessages,
} from "../../../src/domain/session-read-projection";

describe("session read projection", () => {
  test("uses canonical boundaries, normalizes line endings, and preserves empty lines", () => {
    const result = projectSessionMessages([
      { type: "user", messageId: "m1" },
      {
        type: "assistant",
        messageId: "m2",
        state: "completed",
        parts: [{ type: "text", itemKey: "p1", text: "one\r\n\rthree\n" }],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((line) => line.text)).toEqual([
      "[user message omitted]",
      "[assistant]",
      "[assistant: completed]",
      "one",
      "",
      "three",
      "",
    ]);
    expect(result.lines[3]?.start).toEqual({ messageId: "m2", itemKey: "p1", utf8ByteOffset: 0 });
    expect(result.lines[3]?.end.utf8ByteOffset).toBe(4);
  });

  test("wraps by UTF-8 bytes without splitting Unicode scalar values", () => {
    const text = `${"a".repeat(sessionReadLimits.maxRenderedLineBytes - 1)}😀z`;
    const result = projectSessionMessage({
      type: "assistant",
      messageId: "message",
      state: "active",
      parts: [{ type: "text", itemKey: "text", text }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((line) => line.text)).toEqual([
      "[assistant]",
      "[assistant: active]",
      "a".repeat(sessionReadLimits.maxRenderedLineBytes - 1),
      "😀z",
    ]);
    expect(result.lines[3]?.start.utf8ByteOffset).toBe(sessionReadLimits.maxRenderedLineBytes - 1);
    expect(result.lines[3]?.end.utf8ByteOffset).toBe(sessionReadLimits.maxRenderedLineBytes + 4);
  });

  test("rejects unpaired surrogates rather than accepting encoder replacement", () => {
    const result = projectSessionMessage({
      type: "assistant",
      messageId: "message",
      state: "error",
      parts: [{ type: "text", itemKey: "text", text: String.fromCharCode(0xd800) }],
    });
    expect(result).toEqual({
      ok: false,
      message: "Assistant text contains an unpaired Unicode surrogate.",
    });
  });

  test("enforces the per-message line ceiling while scanning newline-heavy text", () => {
    const atLimit = projectSessionMessage({
      type: "assistant",
      messageId: "bounded",
      state: "active",
      parts: [{ type: "text", itemKey: "text", text: "x\n".repeat(8_189) }],
    });
    expect(atLimit.ok && atLimit.lines.length).toBe(sessionReadLimits.maxRenderedLinesPerMessage);

    const excessive = projectSessionMessage({
      type: "assistant",
      messageId: "newline_bomb",
      state: "active",
      parts: [{ type: "text", itemKey: "text", text: "\n".repeat(1_000_000) }],
    });
    expect(excessive).toEqual({
      ok: false,
      message: "Message projection exceeds the rendered line ceiling.",
    });
  });

  test("sanitizes structural tool names but leaves assistant controls untouched", () => {
    const result = projectSessionMessage({
      type: "assistant",
      messageId: "message",
      state: "active",
      parts: [
        { type: "text", itemKey: "text", text: "peer\u001b[31mtext\u202e" },
        { type: "tool", itemKey: "tool", name: "ba\u001b[31msh\u202e", status: "running" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((line) => line.text)).toContain("peer\u001b[31mtext\u202e");
    expect(result.lines.map((line) => line.text)).toContain("[tool: bash running]");
  });

  test("rejects unpaired surrogates in structural metadata", () => {
    const result = projectSessionMessage({
      type: "assistant",
      messageId: "message",
      state: "active",
      parts: [
        {
          type: "tool",
          itemKey: "tool",
          name: `read${String.fromCharCode(0xdc00)}`,
          status: "pending",
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      message: "Tool name contains an unpaired Unicode surrogate.",
    });
  });

  test("never projects native parts into synthesized structural item keys", () => {
    const result = projectSessionMessage({
      type: "assistant",
      messageId: "message",
      state: "active",
      parts: [{ type: "text", itemKey: "$assistant-state", text: "collision" }],
    });
    expect(result).toEqual({
      ok: false,
      message: "Assistant part identity collides with a structural item key.",
    });
  });

  test("bounds tool names by UTF-8 bytes and substitutes sanitized empty names", () => {
    const result = projectSessionMessage({
      type: "assistant",
      messageId: "message",
      state: "completed",
      parts: [
        { type: "tool", itemKey: "empty", name: "\u001b\u202e", status: "completed" },
        { type: "tool", itemKey: "bounded", name: `${"a".repeat(255)}😀suffix`, status: "error" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((line) => line.text)).toContain("[tool: unknown completed]");
    expect(result.lines.map((line) => line.text)).toContain(`[tool: ${"a".repeat(255)} error]`);
  });

  test("propagates projection failures and applies default, zero, and reverse packing limits", () => {
    const failed = projectSessionMessages([
      {
        type: "assistant",
        messageId: "message",
        state: "error",
        parts: [{ type: "text", itemKey: "text", text: String.fromCharCode(0xdc00) }],
      },
    ]);
    expect(failed.ok).toBe(false);

    const projected = projectSessionMessage({
      type: "assistant",
      messageId: "message",
      state: "active",
      parts: [{ type: "text", itemKey: "text", text: "one\ntwo" }],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(packProjectionLines(projected.lines).lines).toHaveLength(projected.lines.length);
    expect(packProjectionLines(projected.lines, 0)).toMatchObject({
      content: "",
      lines: [],
      hasMore: true,
    });
    expect(packProjectionLines(projected.lines, 1, true).lines).toEqual(projected.lines.slice(-1));
  });

  test("packs chronologically without splitting lines and enforces aggregate and line caps", () => {
    const huge = projectSessionMessage({
      type: "assistant",
      messageId: "message",
      state: "completed",
      parts: [{ type: "text", itemKey: "text", text: "x".repeat(200_000) }],
    });
    expect(huge.ok).toBe(true);
    if (!huge.ok) return;
    const packed = packProjectionLines(huge.lines, 500);
    expect(new TextEncoder().encode(packed.content).length).toBeLessThanOrEqual(
      sessionReadLimits.maxContentBytes,
    );
    expect(packed.lines.length).toBeLessThanOrEqual(sessionReadLimits.maxLines);
    expect(packed.hasMore).toBe(true);
    expect(packed.lines.every((line) => new TextEncoder().encode(line.text).length <= 4_096)).toBe(
      true,
    );

    const tail = packProjectionLines(huge.lines, 2, true);
    expect(tail.lines.map((line) => line.text)).toEqual(
      huge.lines.slice(-2).map((line) => line.text),
    );
  });
});
