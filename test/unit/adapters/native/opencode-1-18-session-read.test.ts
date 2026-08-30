import { describe, expect, test } from "bun:test";

import { createOpenCode118NativeAdapter } from "../../../../src/adapters/native/opencode-1-18";
import {
  createOpenCode118SessionReadPort,
  type OpenCode118SessionReadSurface,
} from "../../../../src/adapters/native/opencode-1-18-session-read";
import { sessionReadLimits } from "../../../../src/domain/session-read";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:read"));
const foreignWorkspace = valid(validateWorkspaceKey("workspace:foreign"));
const sessionId = valid(validateSessionId("ses_read"));
const abort = new AbortController().signal;
const inertHostFetch: typeof fetch = Object.assign(async () => new Response("{}"), {
  preconnect() {},
});

function user(id = "msg_user", secret = "PROMPT_SECRET") {
  return {
    id,
    type: "user",
    text: secret,
    files: [{ url: "ATTACHMENT_SECRET" }],
    metadata: { private: "METADATA_SECRET" },
    time: { created: 1 },
  };
}

function assistant(id = "msg_assistant") {
  return {
    id,
    type: "assistant",
    agent: "AGENT_SECRET",
    model: { providerID: "PROVIDER_SECRET", modelID: "MODEL_SECRET" },
    metadata: { private: "METADATA_SECRET" },
    snapshot: { start: "/PRIVATE/PATH" },
    time: { created: 2, completed: 3 },
    content: [
      { id: "prt_text", type: "text", text: "safe progress" },
      {
        id: "prt_reasoning",
        type: "reasoning",
        text: "REASONING_SECRET",
        providerMetadata: { private: "REASONING_METADATA_SECRET" },
      },
      {
        id: "prt_tool",
        type: "tool",
        name: "read",
        state: {
          status: "completed",
          input: { path: "/TOOL/INPUT/PATH" },
          structured: { secret: "TOOL_STRUCTURED_SECRET" },
          content: [{ text: "TOOL_OUTPUT_SECRET" }],
          attachments: [{ url: "TOOL_ATTACHMENT_SECRET" }],
          outputPaths: ["/TOOL/OUTPUT/PATH"],
          result: "TOOL_RESULT_SECRET",
        },
        time: { created: 2, completed: 3 },
      },
    ],
  };
}

function page(data: unknown, pagination: unknown = {}) {
  return { data: { data, cursor: pagination } };
}

function fixture(input: { readonly page?: unknown; readonly fixed?: unknown } = {}) {
  const calls: Array<{
    readonly operation: string;
    readonly parameters: unknown;
    readonly options: unknown;
  }> = [];
  const surface: OpenCode118SessionReadSurface = {
    async messages(parameters, options) {
      calls.push({ operation: "messages", parameters, options });
      return input.page ?? page([]);
    },
    async message(parameters, options) {
      calls.push({ operation: "message", parameters, options });
      return input.fixed ?? { data: { data: user(parameters.messageID) } };
    },
  };
  return {
    calls,
    port: createOpenCode118SessionReadPort(surface, { workspaceKey, hostFetch: inertHostFetch }),
  };
}

describe("OpenCode 1.18 session message wiring", () => {
  test("wires V2 messages and message through the composed native adapter", async () => {
    const calls: unknown[] = [];
    const hostFetch = Object.assign(async () => new Response("{}"), { preconnect() {} });
    const adapter = createOpenCode118NativeAdapter(
      {
        client: {
          session: {
            list: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
            abort: async () => ({ data: true }),
          },
        },
        directory: "/workspace",
        serverUrl: new URL("http://127.0.0.1:4321/"),
        workspaceKey,
      },
      {
        hostFetch,
        createV2Client: () => ({
          global: { health: async () => ({ data: { healthy: true } }) },
          v2: {
            session: {
              active: async () => ({ data: { data: {} } }),
              list: async () => ({ data: { data: [], cursor: {} } }),
              prompt: async () => ({ data: {} }),
              async messages(parameters, options) {
                calls.push(["messages", parameters, options]);
                return page([user()], { next: null });
              },
              async message(parameters, options) {
                calls.push(["message", parameters, options]);
                return { data: { data: assistant(parameters.messageID) } };
              },
            },
          },
        }),
      },
    );
    expect(
      await adapter.readMessagePage({ workspaceKey, sessionId, order: "desc", abort }),
    ).toMatchObject({ messages: [{ type: "user", messageId: "msg_user" }] });
    expect(
      await adapter.readMessage({ workspaceKey, sessionId, messageId: "msg_fixed", abort }),
    ).toMatchObject({ kind: "found", message: { messageId: "msg_fixed" } });
    expect(calls[0]).toEqual([
      "messages",
      { sessionID: sessionId, limit: sessionReadLimits.nativePageMessages, order: "desc" },
      { signal: abort, fetch: expect.any(Function), throwOnError: false },
    ]);
  });

  test("supplies a fail-closed bounded override for injected V2 construction without host fetch", async () => {
    let suppliedFetch: typeof fetch | undefined;
    const adapter = createOpenCode118NativeAdapter(
      {
        client: {
          session: {
            list: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
            abort: async () => ({ data: true }),
          },
        },
        directory: "/workspace",
        serverUrl: new URL("http://127.0.0.1:4321/"),
        workspaceKey,
      },
      {
        createV2Client: () => ({
          global: { health: async () => ({ data: { healthy: true } }) },
          v2: {
            session: {
              active: async () => ({ data: { data: {} } }),
              list: async () => ({ data: { data: [], cursor: {} } }),
              prompt: async () => ({ data: {} }),
              async messages(_parameters, options) {
                suppliedFetch = options.fetch;
                return page([]);
              },
              async message(_parameters, options) {
                suppliedFetch = options.fetch;
                return { data: user("msg_fixed") };
              },
            },
          },
        }),
      },
    );
    await adapter.readMessagePage({ workspaceKey, sessionId, order: "desc", abort });
    expect(suppliedFetch).toBeFunction();
    await expect(suppliedFetch?.("http://opencode.internal/message")).rejects.toThrow(
      "transport request failed",
    );
  });
});

describe("OpenCode 1.18 restricted session message projection", () => {
  test("projects only marker identity, assistant state, text, and coarse tool state", async () => {
    const omitted = [
      { id: "msg_agent", type: "agent-switched", agent: "AGENT_SWITCH_SECRET" },
      { id: "msg_model", type: "model-switched", model: { id: "MODEL_SWITCH_SECRET" } },
      { id: "msg_synthetic", type: "synthetic", text: "SYNTHETIC_SECRET" },
      { id: "msg_system", type: "system", text: "SYSTEM_SECRET" },
      {
        id: "msg_shell",
        type: "shell",
        command: "SHELL_COMMAND_SECRET",
        output: "SHELL_OUTPUT_SECRET",
      },
      { id: "msg_compaction", type: "compaction", summary: "COMPACTION_SECRET" },
    ];
    const fake = fixture({
      page: page([user(), ...omitted, assistant()], { previous: null, next: "cursor_next" }),
    });
    const result = await fake.port.readMessagePage({
      workspaceKey,
      sessionId,
      order: "asc",
      abort,
    });
    expect(result).toEqual({
      messages: [
        { type: "user", messageId: "msg_user" },
        {
          type: "assistant",
          messageId: "msg_assistant",
          state: "completed",
          parts: [
            { type: "text", itemKey: "prt_text", text: "safe progress" },
            { type: "tool", itemKey: "prt_tool", name: "read", status: "completed" },
          ],
        },
      ],
      examinedMessageCount: 8,
      projectedTextByteCount: 13,
      examinedPartCount: 3,
      previousCursor: null,
      nextCursor: "cursor_next",
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "PROMPT_SECRET",
      "ATTACHMENT_SECRET",
      "METADATA_SECRET",
      "AGENT_SECRET",
      "PROVIDER_SECRET",
      "MODEL_SECRET",
      "REASONING_SECRET",
      "REASONING_METADATA_SECRET",
      "/PRIVATE/PATH",
      "/TOOL/INPUT/PATH",
      "TOOL_STRUCTURED_SECRET",
      "TOOL_OUTPUT_SECRET",
      "TOOL_ATTACHMENT_SECRET",
      "/TOOL/OUTPUT/PATH",
      "TOOL_RESULT_SECRET",
      "AGENT_SWITCH_SECRET",
      "MODEL_SWITCH_SECRET",
      "SYNTHETIC_SECRET",
      "SYSTEM_SECRET",
      "SHELL_COMMAND_SECRET",
      "SHELL_OUTPUT_SECRET",
      "COMPACTION_SECRET",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("accepts bounded visible-ASCII native identities used by OpenCode parts", async () => {
    const result = await fixture({
      page: page([
        {
          ...assistant("msg_$native"),
          content: [{ id: "prt_$native", type: "text", text: "progress" }],
        },
      ]),
    }).port.readMessagePage({ workspaceKey, sessionId, order: "desc", abort });
    expect(result.messages).toMatchObject([
      {
        messageId: "msg_$native",
        parts: [{ itemKey: "prt_$native", text: "progress" }],
      },
    ]);
  });

  test("maps assistant active and error states and all known tool statuses", async () => {
    const statuses = ["pending", "running", "completed", "error"] as const;
    const messages = statuses.map((status, index) => ({
      ...assistant(`msg_${status}`),
      ...(index === 0 ? { time: { created: 1 } } : {}),
      ...(index === 1 ? { error: { message: "PRIVATE_ERROR" } } : {}),
      content: [{ id: `prt_${status}`, type: "tool", name: "task", state: { status } }],
    }));
    const result = await fixture({ page: page(messages) }).port.readMessagePage({
      workspaceKey,
      sessionId,
      order: "desc",
      abort,
    });
    expect(result.messages.map((message) => message.type === "assistant" && message.state)).toEqual(
      ["active", "error", "completed", "completed"],
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR");
  });

  test("uses native cursor pages without combining cursor and order", async () => {
    const fake = fixture({ page: page([], { next: null }) });
    expect(
      await fake.port.readMessagePage({ workspaceKey, sessionId, cursor: "native_cursor", abort }),
    ).toMatchObject({ previousCursor: null, nextCursor: null });
    expect(fake.calls[0]?.parameters).toEqual({
      sessionID: sessionId,
      limit: sessionReadLimits.nativePageMessages,
      cursor: "native_cursor",
    });
  });

  test("returns a fixed projected message and maps only authoritative 404 to not_found", async () => {
    const found = fixture({ fixed: { data: { data: assistant("msg_fixed") } } });
    expect(
      await found.port.readMessage({ workspaceKey, sessionId, messageId: "msg_fixed", abort }),
    ).toMatchObject({ kind: "found", message: { messageId: "msg_fixed" } });

    const resolvedForgerySurface: OpenCode118SessionReadSurface = {
      messages: async () => page([]),
      message: async () => ({ response: new Response(null, { status: 404 }) }),
    };
    const resolvedForgery = createOpenCode118SessionReadPort(resolvedForgerySurface, {
      workspaceKey,
      hostFetch: inertHostFetch,
    });
    await expect(
      resolvedForgery.readMessage({ workspaceKey, sessionId, messageId: "msg_missing", abort }),
    ).rejects.toThrow();

    const authoritativeSurface: OpenCode118SessionReadSurface = {
      messages: async () => page([]),
      message: async () => ({
        error: { name: "NotFoundError" },
        request: new Request("http://127.0.0.1/session/message"),
        response: new Response(null, { status: 404 }),
      }),
    };
    expect(
      await createOpenCode118SessionReadPort(authoritativeSurface, {
        workspaceKey,
        hostFetch: inertHostFetch,
      }).readMessage({
        workspaceKey,
        sessionId,
        messageId: "msg_missing",
        abort,
      }),
    ).toEqual({ kind: "not_found" });

    for (const failure of [
      new Error("network ambiguity"),
      { response: new Response(null, { status: 500 }) },
      { data: { error: "not actually authoritative" } },
      { data: { data: user("msg_missing"), extra: true } },
      { data: { data: user("msg_missing") }, extra: true },
      {
        error: {},
        request: new Request("http://127.0.0.1/session/message"),
        response: new Response(null, { status: 404 }),
        extra: true,
      },
      { error: {}, request: {}, response: new Response(null, { status: 404 }) },
      { error: {}, request: new Request("http://127.0.0.1/session/message"), response: {} },
    ]) {
      const surface: OpenCode118SessionReadSurface = {
        messages: async () => page([]),
        message: async () => failure,
      };
      await expect(
        createOpenCode118SessionReadPort(surface, {
          workspaceKey,
          hostFetch: inertHostFetch,
        }).readMessage({
          workspaceKey,
          sessionId,
          messageId: "msg_missing",
          abort,
        }),
      ).rejects.toThrow();
    }
  });
});

describe("OpenCode 1.18 generated session-read envelopes", () => {
  test("accepts the exact SDK success envelope", async () => {
    const result = await fixture({
      page: {
        ...page([user()]),
        request: new Request("http://127.0.0.1/session/messages"),
        response: new Response(null, { status: 200 }),
      },
    }).port.readMessagePage({ workspaceKey, sessionId, order: "desc", abort });
    expect(result.messages).toEqual([{ type: "user", messageId: "msg_user" }]);
  });
});

describe("OpenCode 1.18 session message fail-closed boundaries", () => {
  test.each([
    ["non-envelope", []],
    ["missing envelope data", {}],
    ["error envelope", { data: { data: [], cursor: {} }, error: {} }],
    ["extra outer envelope key", { ...page([]), extra: true }],
    ["partial SDK envelope", { ...page([]), request: new Request("http://127.0.0.1") }],
    ["extra inner page key", { data: { data: [], cursor: {}, extra: true } }],
    ["extra pagination key", page([], { next: null, extra: true })],
    ["non-dense page", page(Object.assign(new Array(1), {}))],
    [
      "oversized page",
      page(Array.from({ length: sessionReadLimits.nativePageMessages + 1 }, () => user())),
    ],
    ["inherited message", page([Object.assign(Object.create({ inherited: true }), user())])],
    [
      "getter message",
      page([
        Object.defineProperty({ id: "msg_getter", type: "user" }, "text", {
          enumerable: true,
          get() {
            throw new Error("must not execute");
          },
        }),
      ]),
    ],
    ["unknown message", page([{ id: "msg_unknown", type: "future" }])],
    ["unknown part", page([{ ...assistant(), content: [{ id: "prt_future", type: "future" }] }])],
    [
      "unknown tool status",
      page([
        {
          ...assistant(),
          content: [{ id: "prt_tool", type: "tool", name: "read", state: { status: "future" } }],
        },
      ]),
    ],
    ["duplicate message", page([user("msg_duplicate"), user("msg_duplicate")])],
    [
      "duplicate part",
      page([
        {
          ...assistant(),
          content: [
            { id: "prt_duplicate", type: "text", text: "one" },
            { id: "prt_duplicate", type: "text", text: "two" },
          ],
        },
      ]),
    ],
    ["invalid ID", page([user("bad id")])],
    ["oversized ID", page([user(`m${"x".repeat(256)}`)])],
    [
      "oversized text",
      page([
        {
          ...assistant(),
          content: [{ id: "prt_text", type: "text", text: "x".repeat(1_048_577) }],
        },
      ]),
    ],
    [
      "oversized content",
      page([
        {
          ...assistant(),
          content: Array.from({ length: 4_097 }, (_, index) => ({
            id: `p${index}`,
            type: "reasoning",
            text: "x",
          })),
        },
      ]),
    ],
    ["malformed pagination", page([], [])],
    [
      "oversized cursor",
      page([], { next: "x".repeat(sessionReadLimits.maxNativeCursorCharacters + 1) }),
    ],
    ["control cursor", page([], { next: "bad cursor" })],
    ["explicit undefined cursor", page([], { next: undefined })],
  ])("rejects %s", async (_label, response) => {
    await expect(
      fixture({ page: response }).port.readMessagePage({
        workspaceKey,
        sessionId,
        order: "asc",
        abort,
      }),
    ).rejects.toThrow();
  });

  test("rejects foreign workspace, malformed session, aborted signals, and invalid request cursors", async () => {
    const fake = fixture();
    const aborted = new AbortController();
    aborted.abort("deadline");
    const requests = [
      { workspaceKey: foreignWorkspace, sessionId, order: "asc" as const, abort },
      { workspaceKey, sessionId: "bad" as never, order: "asc" as const, abort },
      { workspaceKey, sessionId, order: "asc" as const, abort: aborted.signal },
      { workspaceKey, sessionId, cursor: "bad cursor", abort },
      {
        workspaceKey,
        sessionId,
        cursor: "x".repeat(sessionReadLimits.maxNativeCursorCharacters + 1),
        abort,
      },
      { workspaceKey, sessionId, cursor: "cursor", order: "asc" as never, abort },
    ];
    for (const request of requests) {
      await expect(fake.port.readMessagePage(request)).rejects.toThrow();
    }
    expect(fake.calls).toHaveLength(0);
  });

  test("passes exact abort, throw policy, and a response-bounded host transport per call", async () => {
    const calls: unknown[] = [];
    const hostFetch: typeof fetch = Object.assign(
      async () => new Response("x".repeat(sessionReadLimits.maxNativeResponseBytes + 1)),
      { preconnect() {} },
    );
    const surface: OpenCode118SessionReadSurface = {
      async messages(_parameters, options) {
        calls.push(options);
        if (!options.fetch) throw new Error("missing bounded transport");
        await options.fetch("http://opencode.internal/message");
        return page([]);
      },
      message: async () => ({ data: { data: user() } }),
    };
    const port = createOpenCode118SessionReadPort(surface, { workspaceKey, hostFetch });
    await expect(
      port.readMessagePage({ workspaceKey, sessionId, order: "desc", abort }),
    ).rejects.toThrow("byte ceiling");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ signal: abort, throwOnError: false });
  });
});
