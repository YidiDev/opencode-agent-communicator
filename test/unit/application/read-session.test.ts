import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readSession } from "../../../src/application/read-session";
import type { SessionReadPorts } from "../../../src/application/session-read-ports";
import type { ProjectionSafeMessage } from "../../../src/domain/session-read";
import type { SessionId } from "../../../src/domain/sessions";
import type { WorkspaceKey } from "../../../src/domain/workspaces";
import { nativeFoundFixture, nativePageFixture } from "../../support/session-read-fixtures";

const workspace = "workspace" as WorkspaceKey;
const source = "ses_source" as SessionId;
const target = "ses_target" as SessionId;

function fixture(
  options: {
    sourceId?: SessionId;
    messages?: ProjectionSafeMessage[];
    approval?: "approved" | "rejected";
  } = {},
) {
  const events: string[] = [];
  const bindings: unknown[] = [];
  let messages = options.messages ?? [];
  let fixed = new Map(messages.map((message) => [message.messageId, message]));
  const ports: SessionReadPorts = {
    readiness: {
      assertReady() {
        events.push("ready");
      },
    },
    membership: {
      async observeSessionReadPresence() {
        events.push("presence");
        return {
          sourceVisible: true,
          targetVisible: true,
          targetStatus: "busy" as const,
          observedAtMs: 5,
        };
      },
    },
    approval: {
      async requestReadApproval(binding) {
        events.push("approval");
        bindings.push(binding);
        return options.approval ?? "approved";
      },
    },
    native: {
      async readMessagePage(request) {
        events.push(request.cursor === undefined ? `page:${request.order}` : "page:cursor");
        return nativePageFixture(messages);
      },
      async readMessage(request) {
        events.push("fixed");
        const message = fixed.get(request.messageId);
        return message
          ? nativeFoundFixture(message)
          : { kind: "not_found", rawResponseByteCount: 0 };
      },
    },
    digest: {
      async sha256(input) {
        return new Uint8Array(createHash("sha256").update(input).digest());
      },
    },
    clock: { nowMs: () => 1_000 },
    timer: {
      arm() {
        return { cancel() {} };
      },
    },
  };
  return {
    ports,
    events,
    bindings,
    setMessages(value: ProjectionSafeMessage[]) {
      messages = value;
      fixed = new Map(value.map((message) => [message.messageId, message]));
    },
    context: {
      workspaceKey: workspace,
      sourceSessionId: options.sourceId ?? source,
      abort: new AbortController().signal,
      deadlineMs: 2_000,
    },
  };
}

function assistant(text: string, state: "active" | "completed" = "active"): ProjectionSafeMessage {
  return {
    type: "assistant",
    messageId: "msg_assistant",
    state,
    parts: [{ type: "text", itemKey: "part_text", text }],
  };
}

describe("readSession", () => {
  test("asserts readiness before strict validation and performs no lookup for invalid arguments", async () => {
    const f = fixture();
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      direction: "before",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(f.events).toEqual(["ready"]);
  });

  test("reads a self transcript in chronological order without approval", async () => {
    const f = fixture({
      sourceId: target,
      messages: [assistant("hello", "completed"), { type: "user", messageId: "msg_user" }],
    });
    const result = await readSession(f.ports, f.context, { sessionId: target });
    expect(result).toMatchObject({
      ok: true,
      value: {
        content: "[user message omitted]\n[assistant]\n[assistant: completed]\nhello",
        hasMoreBefore: false,
        hasMoreAfter: false,
        observedAtMs: 5,
        isLive: true,
      },
    });
    expect(f.events).not.toContain("approval");
    expect(f.events.filter((event) => event === "presence").length).toBeGreaterThanOrEqual(4);
  });

  test.each([100, 500])(
    "returns exactly the allowed %i-line page with lookahead",
    async (limit) => {
      const text = Array.from({ length: 600 }, (_, index) => `line ${index}`).join("\n");
      const f = fixture({ sourceId: target, messages: [assistant(text)] });
      const result = await readSession(f.ports, f.context, { sessionId: target, limit });
      if (!result.ok) throw new Error("fixture read failed");
      expect(result.value.content.split("\n")).toHaveLength(limit);
      expect(result.value.hasMoreBefore).toBe(true);
      expect(result.value.hasMoreAfter).toBe(false);
    },
  );

  test("uses exact cross-session approval and includes only a cursor digest", async () => {
    const f = fixture({ messages: [assistant("old")] });
    const first = await readSession(f.ports, f.context, { sessionId: target });
    if (!first.ok) throw new Error("fixture read failed");
    f.bindings.length = 0;
    const cursor = first.value.endCursor;
    const second = await readSession(f.ports, f.context, { sessionId: target, cursor });
    expect(second.ok).toBe(true);
    expect(f.bindings).toHaveLength(1);
    expect(f.bindings[0]).toMatchObject({
      workspaceKey: workspace,
      sourceSessionId: source,
      targetSessionId: target,
      projectionVersion: 1,
      mode: "after",
      lineLimit: 100,
      aggregateByteCap: 65_536,
      cursorSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(f.bindings[0])).not.toContain(cursor);
    expect(JSON.stringify(f.bindings[0])).not.toContain("old");
  });

  test("returns only the UTF-8-safe suffix appended after a text cursor", async () => {
    const f = fixture({ sourceId: target, messages: [assistant("hello 🌍")] });
    const tail = await readSession(f.ports, f.context, { sessionId: target, limit: 1 });
    if (!tail.ok) throw new Error("fixture read failed");
    f.setMessages([assistant("hello 🌍 again")]);
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
      direction: "after",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { content: " again", hasMoreAfter: false },
    });
  });

  test.each([
    ["ASCII", "x".repeat(4_096), "!"],
    ["multibyte", `${"界".repeat(1_364)}xxxx`, "🌍"],
  ])("keeps an exact 4096-byte %s wrap boundary append-stable", async (_label, before, suffix) => {
    expect(new TextEncoder().encode(before).length).toBe(4_096);
    const f = fixture({ sourceId: target, messages: [assistant(before)] });
    const tail = await readSession(f.ports, f.context, { sessionId: target, limit: 1 });
    if (!tail.ok) throw new Error("fixture read failed");
    f.setMessages([assistant(`${before}${suffix}`)]);
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
      direction: "after",
    });
    expect(result).toMatchObject({ ok: true, value: { content: suffix } });
  });

  test.each([
    ["", "a", "a"],
    ["one\n", "one\ntwo", "two"],
  ])("keeps a zero-length text boundary append-stable", async (before, after, suffix) => {
    const f = fixture({ sourceId: target, messages: [assistant(before)] });
    const tail = await readSession(f.ports, f.context, { sessionId: target, limit: 1 });
    if (!tail.ok) throw new Error("fixture read failed");
    f.setMessages([assistant(after)]);
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
    });
    expect(result).toMatchObject({ ok: true, value: { content: suffix } });
  });

  test("aborts a pending native read when the deadline timer wakes", async () => {
    let wake: (() => void) | undefined;
    let nativeSignal: AbortSignal | undefined;
    const f = fixture({ sourceId: target });
    f.ports.timer.arm = (_delay, callback) => {
      wake = callback;
      return { cancel() {} };
    };
    f.ports.native.readMessagePage = ({ abort }) => {
      nativeSignal = abort;
      return new Promise(() => {});
    };
    const pending = readSession(f.ports, f.context, { sessionId: target });
    await new Promise((resolve) => setTimeout(resolve, 0));
    wake?.();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    expect(nativeSignal?.aborted).toBe(true);
  });

  test("fails a visibility race before any native transcript read", async () => {
    const f = fixture({ sourceId: target, messages: [assistant("secret")] });
    let observations = 0;
    f.ports.membership.observeSessionReadPresence = async () => {
      observations += 1;
      return {
        sourceVisible: true,
        targetVisible: observations === 1,
        targetStatus: "busy",
        observedAtMs: 5,
      };
    };
    const result = await readSession(f.ports, f.context, { sessionId: target });
    expect(result).toMatchObject({ ok: false, error: { code: "target_not_visible" } });
    expect(f.events.some((event) => event.startsWith("page:"))).toBe(false);
  });

  test("allows visible context reads with unknown activity and no liveness claim", async () => {
    const f = fixture({ sourceId: target });
    f.ports.membership.observeSessionReadPresence = async () => ({
      sourceVisible: true,
      targetVisible: true,
      targetStatus: "unknown",
      observedAtMs: 5,
    });
    const result = await readSession(f.ports, f.context, { sessionId: target });
    expect(result).toMatchObject({ ok: true, value: { isLive: false } });
  });
});

describe("readSession cursor and race handling", () => {
  test("returns before lines chronologically with accurate directional flags", async () => {
    const f = fixture({ sourceId: target, messages: [assistant("one\ntwo")] });
    const tail = await readSession(f.ports, f.context, { sessionId: target, limit: 1 });
    if (!tail.ok) throw new Error("fixture read failed");
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.startCursor,
      direction: "before",
      limit: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        content: "[assistant]\n[assistant: active]\none",
        hasMoreBefore: false,
        hasMoreAfter: true,
      },
    });
  });

  test("returns an active in-place append with accurate after flags", async () => {
    const f = fixture({ sourceId: target, messages: [assistant("one")] });
    const tail = await readSession(f.ports, f.context, { sessionId: target });
    if (!tail.ok) throw new Error("fixture read failed");
    f.setMessages([assistant("one\ntwo\nthree")]);
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
      direction: "after",
      limit: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { content: "two", hasMoreBefore: true, hasMoreAfter: true, isLive: true },
    });
  });

  test("does not report a false continuation when an active cursor has no append", async () => {
    const f = fixture({ sourceId: target, messages: [assistant("unchanged")] });
    const tail = await readSession(f.ports, f.context, { sessionId: target });
    if (!tail.ok) throw new Error("fixture read failed");
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
      direction: "after",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { content: "", hasMoreBefore: true, hasMoreAfter: false },
    });
  });

  test("detects a stale edit before a text boundary", async () => {
    const f = fixture({ sourceId: target, messages: [assistant("hello")] });
    const tail = await readSession(f.ports, f.context, { sessionId: target, limit: 1 });
    if (!tail.ok) throw new Error("fixture read failed");
    f.setMessages([assistant("jello")]);
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "cursor_stale" } });
  });
});

describe("readSession guarded races", () => {
  test("uses the guarded final fixed anchor and includes an append racing the page read", async () => {
    const original = assistant("one");
    const appended = assistant("one two");
    const f = fixture({ sourceId: target, messages: [original] });
    const tail = await readSession(f.ports, f.context, { sessionId: target, limit: 1 });
    if (!tail.ok) throw new Error("fixture read failed");
    let fixedCalls = 0;
    f.ports.native.readMessage = async () => {
      fixedCalls += 1;
      return nativeFoundFixture(fixedCalls === 1 ? original : appended);
    };
    f.ports.native.readMessagePage = async () => nativePageFixture([appended]);
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
    });
    expect(result).toMatchObject({ ok: true, value: { content: " two" } });
    expect(fixedCalls).toBe(2);
  });

  test("rejects an anchor prefix edit racing the final fixed reread", async () => {
    const original = assistant("one");
    const edited = assistant("won");
    const f = fixture({ sourceId: target, messages: [original] });
    const tail = await readSession(f.ports, f.context, { sessionId: target, limit: 1 });
    if (!tail.ok) throw new Error("fixture read failed");
    let fixedCalls = 0;
    f.ports.native.readMessage = async () => {
      fixedCalls += 1;
      return nativeFoundFixture(fixedCalls === 1 ? original : edited);
    };
    f.ports.native.readMessagePage = async () => nativePageFixture([original]);
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "cursor_stale" } });
  });

  test("rechecks presence before each page and immediately before disclosure", async () => {
    const f = fixture({ sourceId: target, messages: [assistant("secret")] });
    let observations = 0;
    f.ports.membership.observeSessionReadPresence = async () => {
      observations += 1;
      return {
        sourceVisible: true,
        targetVisible: observations < 4,
        targetStatus: "busy",
        observedAtMs: observations,
      };
    };
    const result = await readSession(f.ports, f.context, { sessionId: target });
    expect(result).toMatchObject({ ok: false, error: { code: "target_not_visible" } });
    expect(f.events).toContain("page:desc");
  });

  test("stops a visibility race between native pages", async () => {
    const f = fixture({ sourceId: target });
    let observations = 0;
    let pageCalls = 0;
    f.ports.membership.observeSessionReadPresence = async () => {
      observations += 1;
      return {
        sourceVisible: true,
        targetVisible: observations < 4,
        targetStatus: "idle",
        observedAtMs: observations,
      };
    };
    f.ports.native.readMessagePage = async () => {
      pageCalls += 1;
      return nativePageFixture([], `page_${pageCalls}`);
    };
    const result = await readSession(f.ports, f.context, { sessionId: target });
    expect(result).toMatchObject({ ok: false, error: { code: "target_not_visible" } });
    expect(pageCalls).toBe(1);
  });

  test("revalidates visible context when activity becomes unknown between fixed reads", async () => {
    const message = assistant("one");
    const f = fixture({ sourceId: target, messages: [message] });
    const tail = await readSession(f.ports, f.context, { sessionId: target, limit: 1 });
    if (!tail.ok) throw new Error("fixture read failed");
    let observations = 0;
    let fixedCalls = 0;
    f.ports.membership.observeSessionReadPresence = async () => {
      observations += 1;
      return {
        sourceVisible: true,
        targetVisible: true,
        targetStatus: observations >= 5 ? "unknown" : "busy",
        observedAtMs: observations,
      };
    };
    f.ports.native.readMessage = async () => {
      fixedCalls += 1;
      return nativeFoundFixture(message);
    };
    const result = await readSession(f.ports, f.context, {
      sessionId: target,
      cursor: tail.value.endCursor,
    });
    expect(result).toMatchObject({ ok: true, value: { isLive: false } });
    expect(fixedCalls).toBe(2);
  });

  test("links deadline cancellation into a pending presence observation", async () => {
    let wake: (() => void) | undefined;
    let presenceSignal: AbortSignal | undefined;
    const f = fixture({ sourceId: target });
    f.ports.timer.arm = (_delay, callback) => {
      wake = callback;
      return { cancel() {} };
    };
    f.ports.membership.observeSessionReadPresence = async (_workspace, _source, _target, abort) => {
      presenceSignal = abort;
      return new Promise(() => {});
    };
    const pending = readSession(f.ports, f.context, { sessionId: target });
    await new Promise((resolve) => setTimeout(resolve, 0));
    wake?.();
    expect(await pending).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    expect(presenceSignal?.aborted).toBe(true);
    expect(f.events.some((event) => event.startsWith("page:"))).toBe(false);
  });

  test("maps malformed native DTOs to native_unavailable", async () => {
    const f = fixture({ sourceId: target });
    f.ports.native.readMessagePage = async () =>
      ({ messages: [], previousCursor: undefined, nextCursor: null }) as never;
    const result = await readSession(f.ports, f.context, { sessionId: target });
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
  });

  test("stops ambiguous empty pagination at the exact native-call budget", async () => {
    const f = fixture({ sourceId: target });
    let calls = 0;
    f.ports.native.readMessagePage = async () => {
      calls += 1;
      return nativePageFixture([], `next_${calls}`);
    };
    const result = await readSession(f.ports, f.context, { sessionId: target });
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(calls).toBe(96);
  });

  test("never exceeds the aggregate UTF-8 byte cap", async () => {
    const longText = Array.from({ length: 20 }, () => "界".repeat(1_300)).join("\n");
    const f = fixture({ sourceId: target, messages: [assistant(longText)] });
    const result = await readSession(f.ports, f.context, { sessionId: target, limit: 500 });
    if (!result.ok) throw new Error("fixture read failed");
    expect(new TextEncoder().encode(result.value.content).length).toBeLessThanOrEqual(65_536);
    expect(result.value.hasMoreBefore).toBe(true);
  });
});
