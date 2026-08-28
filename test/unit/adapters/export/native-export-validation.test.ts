import { describe, expect, test } from "bun:test";
import { exportKeys, exportRecord } from "../../../../src/adapters/export/native-export-shape";
import { validNativeToolState } from "../../../../src/adapters/export/native-export-tool-state";
import { validateNativeExport } from "../../../../src/adapters/export/native-export-validation";

const sessionId = "ses_export" as never;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function validExport(sanitized: boolean): unknown {
  return {
    info: {
      id: sessionId,
      slug: "session",
      projectID: "project",
      title: sanitized ? `[redacted:session-title:${sessionId}]` : "private",
      directory: sanitized ? `[redacted:session-directory:${sessionId}]` : "/private",
      version: "1.18.23",
      time: { created: 1, updated: 2 },
    },
    messages: [
      {
        info: {
          id: "msg_1",
          sessionID: sessionId,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
        },
        parts: [
          { id: "part_1", sessionID: sessionId, messageID: "msg_1", type: "text", text: "hello" },
        ],
      },
    ],
  };
}

interface MutableNativeExport {
  info: Record<string, unknown>;
  messages: Array<{
    info: Record<string, unknown>;
    parts?: Array<Record<string, unknown>>;
  }>;
}

function firstMessage(value: MutableNativeExport): MutableNativeExport["messages"][number] {
  const message = value.messages[0];
  if (!message) throw new Error("missing fixture message");
  return message;
}

function firstPart(value: MutableNativeExport): Record<string, unknown> {
  const part = firstMessage(value).parts?.[0];
  if (!part) throw new Error("missing fixture part");
  return part;
}

describe("native export validation", () => {
  test("accepts only plain export records with exact declared keys", () => {
    expect(exportRecord(Object.create(null))).toBeDefined();
    expect(exportRecord(new Date())).toBeUndefined();
    expect(exportKeys({ required: true }, ["required"])).toBe(true);
    expect(exportKeys({ required: true, injected: true }, ["required"])).toBe(false);
  });

  test("rejects incomplete tool states and accepts completed optional compaction timing", () => {
    expect(validNativeToolState(null)).toBe(false);
    expect(validNativeToolState({ status: "pending", input: {}, raw: 1 })).toBe(false);
    expect(
      validNativeToolState({ status: "running", input: {}, time: { start: 1 }, title: 1 }),
    ).toBe(false);
    expect(
      validNativeToolState({
        status: "completed",
        input: {},
        output: "done",
        title: "Read",
        metadata: {},
        time: { start: 1, end: 2, compacted: 2 },
      }),
    ).toBe(true);
    expect(
      validNativeToolState({
        status: "completed",
        input: {},
        output: "done",
        title: "Read",
        metadata: {},
        time: { start: 1, end: 2, compacted: "later" },
      }),
    ).toBe(false);
  });
});

describe("native export envelope validation", () => {
  test("accepts import-compatible native output and proven sanitizer markers", () => {
    expect(validateNativeExport(encode(validExport(false)), sessionId, false)).toEqual({
      ok: true,
    });
    expect(validateNativeExport(encode(validExport(true)), sessionId, true)).toEqual({ ok: true });
  });

  test("rejects malformed, extra, wrong-session, and unproven sanitized output", () => {
    expect(validateNativeExport(new TextEncoder().encode("{"), sessionId, true)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(
      validateNativeExport(
        encode({ ...(validExport(true) as object), extra: true }),
        sessionId,
        true,
      ),
    ).toMatchObject({ ok: false, reason: "malformed" });
    const wrong = validExport(true) as { info: { id: string } };
    wrong.info.id = "ses_other";
    expect(validateNativeExport(encode(wrong), sessionId, true)).toMatchObject({
      ok: false,
      reason: "wrong_session",
    });
    expect(validateNativeExport(encode(validExport(false)), sessionId, true)).toMatchObject({
      ok: false,
      reason: "not_sanitized",
    });
    expect(
      validateNativeExport(
        encode({ info: { id: sessionId, title: "", directory: "" }, messages: [{}] }),
        sessionId,
        true,
      ),
    ).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("requires every declared part variant and exact cross-session/message bindings", () => {
    const value = validExport(true) as {
      messages: Array<{ info: { id: string }; parts: unknown[] }>;
    };
    const message = value.messages[0];
    if (!message) throw new Error("missing fixture message");
    const common = { sessionID: sessionId, messageID: "msg_1" };
    message.parts = [
      { id: "p1", ...common, type: "text", text: "x" },
      { id: "p2", ...common, type: "reasoning", text: "x", time: { start: 1 } },
      { id: "p3", ...common, type: "file", mime: "text/plain", url: "data:text/plain,x" },
      {
        id: "p4",
        ...common,
        type: "tool",
        callID: "c",
        tool: "read",
        state: { status: "pending", input: {}, raw: "" },
      },
      { id: "p5", ...common, type: "step-start" },
      {
        id: "p6",
        ...common,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { id: "p7", ...common, type: "snapshot", snapshot: "s" },
      { id: "p8", ...common, type: "patch", hash: "h", files: [] },
      { id: "p9", ...common, type: "agent", name: "build" },
      { id: "p10", ...common, type: "retry", attempt: 1, error: {}, time: { created: 1 } },
      { id: "p11", ...common, type: "compaction", auto: true },
      { id: "p12", ...common, type: "subtask", prompt: "p", description: "d", agent: "build" },
    ];
    expect(validateNativeExport(encode(value), sessionId, true)).toEqual({ ok: true });
    (message.parts[4] as { messageID: string }).messageID = "msg_swapped";
    expect(validateNativeExport(encode(value), sessionId, true)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    (message.parts[4] as { messageID: string }).messageID = "msg_1";
    (message.parts[3] as { state: unknown }).state = {
      status: "completed",
      input: {},
      output: "x",
      title: "x",
      metadata: {},
      time: { start: 1 },
    };
    expect(validateNativeExport(encode(value), sessionId, true)).toMatchObject({ ok: false });
  });

  test("accepts assistant metadata and every finite tool lifecycle state", () => {
    const value = validExport(true) as {
      messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
    };
    const message = value.messages[0];
    if (!message) throw new Error("missing fixture message");
    message.info = {
      id: "msg_assistant",
      sessionID: sessionId,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "msg_parent",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: {
        input: 1,
        output: 2,
        reasoning: 3,
        total: 6,
        cache: { read: 0, write: 0 },
      },
      summary: false,
      variant: "fast",
      finish: "stop",
      error: {},
    };
    message.parts = [
      {
        id: "part_tool",
        sessionID: sessionId,
        messageID: "msg_assistant",
        type: "tool",
        callID: "call",
        tool: "read",
        state: {
          status: "running",
          input: {},
          time: { start: 1 },
          title: "Reading",
          metadata: {},
        },
      },
    ];
    expect(validateNativeExport(encode(value), sessionId, true)).toEqual({ ok: true });

    expect(
      validNativeToolState({
        status: "error",
        input: {},
        error: "denied",
        time: { start: 1, end: 2 },
        metadata: {},
      }),
    ).toBe(true);
    expect(validNativeToolState({ status: "invented", input: {} })).toBe(false);
  });

  test("rejects malformed assistant bindings and hostile object maps", () => {
    const value = validExport(true) as {
      messages: Array<{ info: Record<string, unknown>; parts: unknown[] }>;
    };
    const message = value.messages[0];
    if (!message) throw new Error("missing fixture message");
    message.info = {
      id: "msg_user",
      sessionID: sessionId,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      tools: { read: true, write: "yes" },
    };
    expect(validateNativeExport(encode(value), sessionId, true)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    message.info.role = "system";
    expect(validateNativeExport(encode(value), sessionId, true)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("native export malformed envelope boundaries", () => {
  test("rejects malformed session, message, unknown-part, and empty message envelopes", () => {
    for (const mutate of [
      (value: MutableNativeExport) => (value.info.slug = 1),
      (value: MutableNativeExport) => (firstMessage(value).info.id = 1),
      (value: MutableNativeExport) => (firstMessage(value).info.role = "assistant"),
      (value: MutableNativeExport) => (firstPart(value).type = "invented"),
      (value: MutableNativeExport) => (value.messages[0] = { info: firstMessage(value).info }),
    ]) {
      const value = validExport(true) as MutableNativeExport;
      mutate(value);
      expect(validateNativeExport(encode(value), sessionId, true)).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });
});
