import { describe, expect, test } from "bun:test";

import { createOpenCode118NativeAdapter } from "../../../../src/adapters/native/opencode-1-18";
import {
  validateManagedSessionId,
  validateNativeMessageId,
} from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:coverage-deficits"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const managedSessionId = valid(validateManagedSessionId(`ses_${"c".repeat(32)}`));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"d".repeat(32)}`));
const envelope = (data: unknown) => ({ data });

function v2Session(overrides: Record<string, unknown> = {}) {
  return {
    active: async () => envelope({ data: {} }),
    list: async () => envelope({ data: [], cursor: {} }),
    prompt: async () => envelope({ data: {} }),
    ...overrides,
  };
}

function legacyClient(overrides: Record<string, unknown> = {}) {
  return {
    _client: { getConfig: () => ({ fetch: globalThis.fetch, headers: new Headers() }) },
    experimental: { session: { list: async () => envelope([]) } },
    session: {
      list: async () => envelope([]),
      status: async () => envelope({}),
      abort: async () => envelope(true),
      update: async () => envelope(true),
    },
    ...overrides,
  };
}

function adapter(
  input: {
    client?: unknown;
    session?: Record<string, unknown>;
    publicSession?: Record<string, unknown>;
    now?: () => number;
  } = {},
) {
  return createOpenCode118NativeAdapter(
    {
      client: input.client === undefined ? legacyClient() : input.client,
      directory: "/workspace",
      serverUrl: new URL("http://127.0.0.1:4321/"),
      workspaceKey,
    },
    {
      ...(input.now === undefined ? {} : { now: input.now }),
      createV2Client: () => ({
        global: { health: async () => envelope({ healthy: true, version: "1.18.23" }) },
        experimental: { session: { list: async () => envelope([]) } },
        session: {
          update: async () => envelope(true),
          prompt: async () => envelope(true),
          ...input.publicSession,
        },
        v2: { session: v2Session(input.session) },
      }),
    },
  );
}

describe("OpenCode 1.18.23 exact native surface failures", () => {
  test("constructs the pinned SDK client when no dependency overrides are supplied", () => {
    expect(
      createOpenCode118NativeAdapter({
        client: legacyClient(),
        directory: "/workspace",
        serverUrl: new URL("http://127.0.0.1:4321/"),
        workspaceKey,
      }),
    ).toBeDefined();
  });

  test.each([
    ["null client", null],
    ["array client", []],
    [
      "non-callable status",
      legacyClient({ session: { status: true, abort: async () => envelope(true) } }),
    ],
    ["missing interrupt", legacyClient({ session: { status: async () => envelope({}) } })],
  ] as const)("rejects construction with an exact %s surface", (_label, client) => {
    expect(() => adapter({ client })).toThrow("unavailable");
  });

  test("rejects a pinned legacy client without the runtime root listing endpoint", async () => {
    const missing = createOpenCode118NativeAdapter(
      {
        client: legacyClient({
          session: {
            status: async () => envelope({}),
            abort: async () => envelope(true),
            update: async () => envelope(true),
          },
        }),
        directory: "/workspace",
        serverUrl: new URL("http://127.0.0.1:4321/"),
        workspaceKey,
      },
      {
        createV2Client: () => ({
          global: { health: async () => envelope({ healthy: true }) },
          v2: { session: v2Session() },
        }),
      },
    );
    await expect(missing.readVisibleRoots(false)).rejects.toThrow(
      "Pinned legacy root listing is unavailable",
    );
  });

  test("fails closed when the optional V2 read-back and creation methods are absent", async () => {
    const withoutReadBack = adapter();
    expect(
      await withoutReadBack.createRootSession({
        sessionId: managedSessionId,
        abort: new AbortController().signal,
      }),
    ).toBe("unknown");

    const absent = {
      error: {
        _tag: "SessionNotFoundError",
        sessionID: managedSessionId,
        message: "not found",
      },
      response: new Response(null, { status: 404 }),
    };
    const withoutCreate = adapter({ session: { get: async () => absent } });
    expect(
      await withoutCreate.createRootSession({
        sessionId: managedSessionId,
        abort: new AbortController().signal,
      }),
    ).toBe("unknown");
  });

  test("fails closed when the public title-update method is absent", async () => {
    const client = legacyClient({
      session: {
        status: async () => envelope({}),
        abort: async () => envelope(true),
      },
    });
    expect(
      await adapter({
        client,
        session: { get: async () => envelope({}) },
        publicSession: { update: true },
      }).updateSessionTitle({
        sessionId: managedSessionId,
        title: "Renamed",
        abort: new AbortController().signal,
      }),
    ).toBe("unknown");
  });

  test("routes initial start admission through the public prompt surface", async () => {
    const current = adapter({
      publicSession: {
        prompt: async () =>
          envelope({
            info: {
              sessionID: managedSessionId,
              parentID: nativeMessageId,
              role: "assistant",
            },
            parts: [],
          }),
      },
    });
    expect(
      await current.admitInitialMessage({
        sessionId: managedSessionId,
        nativeMessageId,
        message: "visible",
        abort: new AbortController().signal,
      }),
    ).toBe("admitted");
  });
});

describe("OpenCode 1.18.23 runtime validation branches", () => {
  test("rejects malformed configured and supplied workspace identities", async () => {
    expect(() =>
      createOpenCode118NativeAdapter(
        {
          client: legacyClient(),
          directory: "/workspace",
          serverUrl: new URL("http://127.0.0.1:4321/"),
          workspaceKey: "" as never,
        },
        {
          createV2Client: () => ({
            global: { health: async () => envelope({ healthy: true }) },
            v2: { session: v2Session() },
          }),
        },
      ),
    ).toThrow();

    await expect(
      adapter().readCurrentRoots("" as never, sourceSessionId, targetSessionId),
    ).rejects.toThrow("Workspace binding");
    await expect(
      adapter().observeRequestParticipants(
        "" as never,
        sourceSessionId,
        targetSessionId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Workspace binding");
  });

  test("rejects a negative observation clock", async () => {
    await expect(adapter({ now: () => -1 }).readVisibleRoots(false)).rejects.toThrow("clock");
  });

  test("does not call interrupt for a malformed target identity", async () => {
    let called = false;
    const client = legacyClient({
      session: {
        status: async () => envelope({}),
        abort: async () => {
          called = true;
          return envelope(true);
        },
        update: async () => envelope(true),
      },
    });
    expect(
      await adapter({ client }).interruptSession({
        targetSessionId: "bad" as never,
        abort: new AbortController().signal,
      }),
    ).toBe("unknown");
    expect(called).toBe(false);
  });

  test("preserves ambiguity when abort wins after the interrupt host call", async () => {
    const controller = new AbortController();
    const client = legacyClient({
      session: {
        status: async () => envelope({}),
        abort: async () => {
          controller.abort("deadline");
          return envelope(true);
        },
        update: async () => envelope(true),
      },
    });
    expect(
      await adapter({ client }).interruptSession({
        targetSessionId,
        abort: controller.signal,
      }),
    ).toBe("unknown");
  });

  test("rejects an observation aborted by a completed host surface", async () => {
    const controller = new AbortController();
    await expect(
      adapter({
        session: {
          active: async () => {
            controller.abort("deadline");
            return envelope({ data: {} });
          },
        },
      }).observeRequestParticipants(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        controller.signal,
      ),
    ).rejects.toThrow("aborted");
  });

  test("rejects a pre-aborted observation before calling host surfaces", async () => {
    const controller = new AbortController();
    controller.abort("deadline");
    const fake = adapter();

    await expect(
      fake.observeRequestParticipants(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        controller.signal,
      ),
    ).rejects.toThrow("aborted");
  });
});
