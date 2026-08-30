import { describe, expect, test } from "bun:test";

import {
  createAdmissionOperations,
  createObservationOperations,
} from "../../../../src/adapters/native/opencode-1-18-operations";
import {
  createOpenCode118SessionReadPort,
  type OpenCode118SessionReadSurface,
} from "../../../../src/adapters/native/opencode-1-18-session-read";
import {
  createBoundedOpenCode118Fetch,
  readOpenCode118Transport,
} from "../../../../src/adapters/native/opencode-1-18-transport";
import { validateNativeMessageId } from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:read-coverage"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"a".repeat(32)}`));
const signal = new AbortController().signal;
const inertFetch = Object.assign(async () => new Response("{}"), { preconnect() {} });
const envelope = (data: unknown) => ({ data });
const page = (data: unknown, cursor: unknown = {}) => ({ data: { data, cursor } });

function assistant(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "msg_assistant_coverage",
    type: "assistant",
    time: { created: 1, completed: 2 },
    content: [{ id: "prt_text_coverage", type: "text", text: "safe" }],
    ...overrides,
  };
}

function readPort(input: { readonly page?: unknown; readonly fixed?: unknown } = {}) {
  const surface: OpenCode118SessionReadSurface = {
    messages: async () => input.page ?? page([]),
    message: async () => input.fixed ?? { data: { data: { id: "msg_fixed", type: "user" } } },
  };
  return createOpenCode118SessionReadPort(surface, { workspaceKey, hostFetch: inertFetch });
}

describe("session read strict reflection and response coverage", () => {
  test.each([
    [
      "record reflection throw",
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("trap");
          },
        },
      ),
    ],
    ["array prototype", page(Object.setPrototypeOf([], null))],
    ["array descriptor", page(Object.defineProperty([{}], "0", { enumerable: false }))],
    [
      "array reflection throw",
      page(
        new Proxy([], {
          ownKeys: () => {
            throw new Error("trap");
          },
        }),
      ),
    ],
    ["negative assistant creation", page([assistant({ time: { created: -1 } })])],
    ["undefined assistant error", page([assistant({ error: undefined })])],
  ])("rejects %s", async (_label, response) => {
    await expect(
      readPort({ page: response }).readMessagePage({
        workspaceKey,
        sessionId: sourceSessionId,
        order: "asc",
        abort: signal,
      }),
    ).rejects.toThrow("malformed");
  });

  test("rejects malformed times, parts, tools, names, and both cursor directions", async () => {
    const malformed = [
      assistant({ time: { created: 1, completed: Number.NaN } }),
      assistant({ content: [Object.assign(new Date(), { id: "part", type: "text", text: "x" })] }),
      assistant({ content: [{ id: "part", type: "tool", name: "bad\nname", state: [] }] }),
      assistant({
        content: [
          { id: "part", type: "tool", name: "x".repeat(257), state: { status: "running" } },
        ],
      }),
      assistant({ content: [{ id: "part", type: "text", text: 4 }] }),
    ];
    for (const message of malformed) {
      await expect(
        readPort({ page: page([message]) }).readMessagePage({
          workspaceKey,
          sessionId: sourceSessionId,
          order: "desc",
          abort: signal,
        }),
      ).rejects.toThrow();
    }
    for (const cursor of [undefined, "bad cursor"]) {
      await expect(
        readPort({ page: page([], { previous: cursor }) }).readMessagePage({
          workspaceKey,
          sessionId: sourceSessionId,
          order: "asc",
          abort: signal,
        }),
      ).rejects.toThrow();
    }
  });

  test("covers page and fixed abort, native throws, omitted fixed messages, and mismatch", async () => {
    for (const operation of ["messages", "message"] as const) {
      const controller = new AbortController();
      const surface: OpenCode118SessionReadSurface = {
        messages: async () => {
          if (operation === "messages") throw new Error("native");
          return page([]);
        },
        message: async () => {
          if (operation === "message") throw new Error("native");
          return { data: { id: "msg_fixed", type: "user" } };
        },
      };
      const port = createOpenCode118SessionReadPort(surface, {
        workspaceKey,
        hostFetch: inertFetch,
      });
      const pending =
        operation === "messages"
          ? port.readMessagePage({
              workspaceKey,
              sessionId: sourceSessionId,
              order: "asc",
              abort: controller.signal,
            })
          : port.readMessage({
              workspaceKey,
              sessionId: sourceSessionId,
              messageId: "msg_fixed",
              abort: controller.signal,
            });
      await expect(pending).rejects.toThrow("read failed");
    }

    const controller = new AbortController();
    const aborting: OpenCode118SessionReadSurface = {
      messages: async () => {
        controller.abort();
        return page([]);
      },
      message: async () => {
        controller.abort();
        return { data: { id: "msg_fixed", type: "user" } };
      },
    };
    await expect(
      createOpenCode118SessionReadPort(aborting, {
        workspaceKey,
        hostFetch: inertFetch,
      }).readMessagePage({
        workspaceKey,
        sessionId: sourceSessionId,
        order: "asc",
        abort: controller.signal,
      }),
    ).rejects.toThrow("aborted");

    const fixedController = new AbortController();
    const fixedAborting: OpenCode118SessionReadSurface = {
      messages: async () => page([]),
      message: async () => {
        fixedController.abort();
        return { data: { id: "msg_fixed", type: "user" } };
      },
    };
    await expect(
      createOpenCode118SessionReadPort(fixedAborting, {
        workspaceKey,
        hostFetch: inertFetch,
      }).readMessage({
        workspaceKey,
        sessionId: sourceSessionId,
        messageId: "msg_fixed",
        abort: fixedController.signal,
      }),
    ).rejects.toThrow("aborted");

    for (const fixed of [
      { data: { id: "msg_fixed", type: "system" } },
      { data: { id: "msg_other", type: "user" } },
    ]) {
      await expect(
        readPort({ fixed }).readMessage({
          workspaceKey,
          sessionId: sourceSessionId,
          messageId: "msg_fixed",
          abort: signal,
        }),
      ).rejects.toThrow();
    }
  });

  test("rejects every non-authoritative structured 404 shape", async () => {
    const request = new Request("http://127.0.0.1/message");
    const response = new Response(null, { status: 404 });
    for (const fixed of [
      { error: {}, request, response: new Response(null, { status: 500 }) },
      { error: {}, request: {}, response },
      { error: {}, request, response: {} },
      { error: {}, request, response, extra: true },
    ]) {
      await expect(
        readPort({ fixed }).readMessage({
          workspaceKey,
          sessionId: sourceSessionId,
          messageId: "msg_fixed",
          abort: signal,
        }),
      ).rejects.toThrow();
    }
  });
});

function observation(
  input: { readonly controller?: AbortController; readonly now?: () => number } = {},
) {
  const root = { id: targetSessionId, title: "Target", time: { updated: 1 } };
  const maybeAbort = () => input.controller?.abort();
  return createObservationOperations({
    configuredWorkspace: workspaceKey,
    now: input.now ?? (() => 10),
    health: async () => envelope({ healthy: true }),
    listMetadata: async () => envelope({ data: [root], cursor: {} }),
    listArchivedRoots: async () => envelope([]),
    listVisibleRoots: async () => {
      maybeAbort();
      return envelope([root]);
    },
    readStatus: async () => envelope({ [targetSessionId]: { type: "idle" } }),
    active: async () => envelope({ data: {} }),
  });
}

describe("session read presence and operation coverage", () => {
  test("covers presence visibility, status, malformed identities, aborts, and clocks", async () => {
    expect(
      await observation().observeSessionReadPresence(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        signal,
      ),
    ).toEqual({
      sourceVisible: false,
      targetVisible: true,
      targetStatus: "idle",
      observedAtMs: 10,
    });

    await expect(
      observation().observeSessionReadPresence(
        workspaceKey,
        "bad" as never,
        targetSessionId,
        signal,
      ),
    ).rejects.toThrow("malformed");
    await expect(
      observation().observeSessionReadPresence(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        {} as never,
      ),
    ).rejects.toThrow("aborted");
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      observation().observeSessionReadPresence(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        preAborted.signal,
      ),
    ).rejects.toThrow("aborted");
    const during = new AbortController();
    await expect(
      observation({ controller: during }).observeSessionReadPresence(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        during.signal,
      ),
    ).rejects.toThrow("aborted");
    for (const now of [1.5, -1]) {
      await expect(
        observation({ now: () => now }).observeSessionReadPresence(
          workspaceKey,
          sourceSessionId,
          targetSessionId,
          signal,
        ),
      ).rejects.toThrow("clock");
    }
  });

  test("returns unknown activities for abort before and after observation", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    expect(
      await observation().observeParticipantActivities(
        workspaceKey,
        [targetSessionId],
        preAborted.signal,
      ),
    ).toEqual([{ sessionId: targetSessionId, activity: "unknown" }]);
    const during = new AbortController();
    expect(
      await observation({ controller: during }).observeParticipantActivities(
        workspaceKey,
        [targetSessionId],
        during.signal,
      ),
    ).toEqual([{ sessionId: targetSessionId, activity: "unknown" }]);
    await expect(
      observation().observeParticipantActivities(workspaceKey, [], signal),
    ).rejects.toThrow("malformed");
  });

  test("covers queue admission dispatch", async () => {
    const operations = createAdmissionOperations({
      now: () => 1,
      prompt: async () =>
        envelope({
          info: {
            id: nativeMessageId,
            sessionID: targetSessionId,
            role: "user",
            time: { created: 1 },
          },
          parts: [{ id: "prt_admission", type: "text", text: "safe" }],
        }),
    });
    await operations.queueMessage({
      targetSessionId,
      nativeMessageId,
      envelope: "safe",
      abort: signal,
    });
  });
});

function fetchOf(response: unknown): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe("bounded transport cancellation, errors, and reflection coverage", () => {
  test("distinguishes stream read rejection with and without abort", async () => {
    for (const shouldAbort of [false, true]) {
      const controller = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        pull() {
          if (shouldAbort) controller.abort();
          throw new Error("stream failure");
        },
      });
      await expect(
        createBoundedOpenCode118Fetch(fetchOf(new Response(body)), 8)("http://localhost", {
          signal: controller.signal,
        }),
      ).rejects.toThrow(shouldAbort ? "aborted" : "unreadable");
    }

    const controller = new AbortController();
    const response = new Proxy(new Response("x"), {
      get(target, property) {
        if (property === "body") {
          return {
            getReader() {
              return {
                async read() {
                  controller.abort();
                  throw new Error("read failure after abort");
                },
                async cancel() {},
                releaseLock() {},
              };
            },
          };
        }
        return Reflect.get(target, property, target);
      },
    });
    await expect(
      createBoundedOpenCode118Fetch(fetchOf(response), 8)("http://localhost", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });

  test("swallows cancellation errors and detects abort immediately before body reading", async () => {
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(2));
        },
        cancel() {
          throw new Error("cancel failure");
        },
      }),
    );
    await expect(
      createBoundedOpenCode118Fetch(fetchOf(oversized), 1)("http://localhost"),
    ).rejects.toThrow("byte ceiling");

    const controller = new AbortController();
    await expect(
      createBoundedOpenCode118Fetch(
        (async () => {
          controller.abort();
          return new Response("x");
        }) as unknown as typeof fetch,
        8,
      )("http://localhost", { signal: controller.signal }),
    ).rejects.toThrow("aborted");

    const throwingController = new AbortController();
    await expect(
      createBoundedOpenCode118Fetch(
        (async () => {
          throwingController.abort();
          throw new Error("host failure after abort");
        }) as unknown as typeof fetch,
        8,
      )("http://localhost", { signal: throwingController.signal }),
    ).rejects.toThrow("aborted");
  });

  test("covers malformed response, body access, reader access, and reconstruction", async () => {
    await expect(createBoundedOpenCode118Fetch(fetchOf({}), 8)("http://localhost")).rejects.toThrow(
      "malformed data",
    );

    const bodyTrap = new Proxy(new Response("x"), {
      get(target, property, receiver) {
        if (property === "body") throw new Error("body trap");
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(
      createBoundedOpenCode118Fetch(fetchOf(bodyTrap), 8)("http://localhost"),
    ).rejects.toThrow("unreadable");

    const readerTrap = new Proxy(new Response("x"), {
      get(target, property) {
        if (property === "body")
          return {
            getReader() {
              throw new Error("reader trap");
            },
          };
        return Reflect.get(target, property, target);
      },
    });
    await expect(
      createBoundedOpenCode118Fetch(fetchOf(readerTrap), 8)("http://localhost"),
    ).rejects.toThrow("unreadable");

    const statusTrap = new Proxy(new Response("x"), {
      get(target, property) {
        if (property === "status") throw new Error("status trap");
        return Reflect.get(target, property, target);
      },
    });
    await expect(
      createBoundedOpenCode118Fetch(fetchOf(statusTrap), 8)("http://localhost"),
    ).rejects.toThrow("malformed data");
  });

  test("permits every constructible bodyless status and derives method and signal from Request", async () => {
    for (const status of [204, 205, 304]) {
      expect(
        (
          await createBoundedOpenCode118Fetch(
            fetchOf(new Response(null, { status })),
            0,
          )(new Request("http://localhost", { method: "GET" }))
        ).status,
      ).toBe(status);
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      createBoundedOpenCode118Fetch(
        fetchOf(new Response(null)),
        0,
      )(new Request("http://localhost", { signal: controller.signal })),
    ).rejects.toThrow("aborted");
  });

  test("delegates optional preconnect and fails closed on transport reflection", () => {
    const calls: unknown[] = [];
    const host = Object.assign(fetchOf(new Response("x")), {
      preconnect(url: string | URL, options?: unknown) {
        calls.push([url, options]);
      },
    });
    createBoundedOpenCode118Fetch(host, 8).preconnect("http://localhost", { dns: true });
    expect(calls).toHaveLength(1);
    createBoundedOpenCode118Fetch(fetchOf(new Response("x")), 8).preconnect("http://localhost");

    for (const client of [
      null,
      { _client: [] },
      { _client: { getConfig: true } },
      { _client: { getConfig: () => [] } },
      { _client: { getConfig: () => ({ fetch: true }) } },
    ]) {
      expect(() => readOpenCode118Transport(client)).toThrow("unavailable");
    }
    expect(
      readOpenCode118Transport({
        _client: {
          getConfig: () => ({
            fetch: inertFetch,
            headers: { secret: "kept", "x-opencode-directory": "removed" },
          }),
        },
      }).headers,
    ).toEqual({ secret: "kept" });
  });
});
