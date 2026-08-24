import { describe, expect, test } from "bun:test";

import {
  createOpenCode11821NativeAdapter,
  type OpenCodeNativeAdapterDependencies,
} from "../../../../src/adapters/native/opencode-1-18-21";
import { validateNativeMessageId } from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

interface FixtureOptions {
  readonly health?: unknown;
  readonly listed?: unknown;
  readonly visibleRoots?: unknown;
  readonly archivedRoots?: unknown;
  readonly statuses?: unknown;
  readonly active?: unknown;
  readonly promptResponse?: unknown;
  readonly promptThrows?: boolean;
  readonly onPrompt?: () => void;
}

function envelope(data: unknown): { readonly data: unknown } {
  return { data };
}

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:one"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"a".repeat(32)}`));

function fixture(options: FixtureOptions = {}) {
  const calls: Array<{ readonly surface: string; readonly input?: unknown }> = [];
  const dependencies: OpenCodeNativeAdapterDependencies = {
    now: () => 7000,
    createV2Client(configuration) {
      calls.push({ surface: "createV2", input: configuration });
      return {
        global: {
          async health(): Promise<unknown> {
            calls.push({ surface: "health" });
            return envelope(options.health ?? { healthy: true, version: "1.18.21" });
          },
        },
        v2: {
          session: {
            async active(): Promise<unknown> {
              calls.push({ surface: "v2.active" });
              return envelope({ data: options.active ?? {} });
            },
            async list(input): Promise<unknown> {
              calls.push({ surface: "v2.list", input });
              return envelope({ data: options.listed ?? [], cursor: {} });
            },
            async prompt(input, requestOptions): Promise<unknown> {
              calls.push({ surface: "v2.prompt", input: [input, requestOptions] });
              if (options.promptThrows) throw new Error("private transport detail");
              options.onPrompt?.();
              return options.promptResponse ?? envelope({ data: {} });
            },
          },
        },
      };
    },
  };
  const client = {
    experimental: {
      session: {
        async list(input: unknown): Promise<unknown> {
          calls.push({ surface: "legacy.roots", input });
          const isArchived =
            typeof input === "object" && input !== null && Reflect.get(input, "archived") === true;
          return envelope(
            isArchived ? (options.archivedRoots ?? []) : (options.visibleRoots ?? []),
          );
        },
      },
    },
    session: {
      async status(input: unknown): Promise<unknown> {
        calls.push({ surface: "legacy.status", input });
        return envelope(options.statuses ?? {});
      },
    },
  };
  return {
    calls,
    adapter: createOpenCode11821NativeAdapter(
      {
        client,
        directory: "/workspace",
        serverUrl: new URL("http://127.0.0.1:4321/"),
        workspaceKey,
      },
      dependencies,
    ),
  };
}

function nativeSession(id: string, title: string, updated: number, archived?: number) {
  return archived === undefined
    ? { id, title, time: { created: 1, updated } }
    : { id, title, time: { created: 1, updated, archived } };
}

describe("OpenCode 1.18.21 native adapter", () => {
  test("observes exact request participants and merged target activity without listing V2 metadata", async () => {
    const fake = fixture({
      visibleRoots: [
        nativeSession("ses_source", "source", 1),
        nativeSession("ses_target", "target", 2),
      ],
      statuses: {
        ses_target: { type: "retry", attempt: 1, message: "later", next: 10 },
      },
      active: { ses_target: { type: "running" } },
    });
    expect(
      await fake.adapter.observeRequestParticipants(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        new AbortController().signal,
      ),
    ).toEqual({ sourceVisible: true, targetVisible: true, targetStatus: "retry" });
    expect(fake.calls.filter((call) => call.surface === "v2.list")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.surface === "legacy.roots")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.surface === "legacy.status")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.surface === "v2.active")).toHaveLength(1);
  });

  test("rejects inherited and getter-backed request activity maps", async () => {
    const inherited = Object.create({ ses_target: { type: "busy" } });
    const getter = Object.defineProperty({}, "ses_target", {
      enumerable: true,
      get() {
        return { type: "running" };
      },
    });
    for (const options of [{ statuses: inherited }, { active: getter }]) {
      const fake = fixture({
        visibleRoots: [
          nativeSession("ses_source", "source", 1),
          nativeSession("ses_target", "target", 2),
        ],
        ...options,
      });
      await expect(
        fake.adapter.observeRequestParticipants(
          workspaceKey,
          sourceSessionId,
          targetSessionId,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
  });

  test("constructs V2 from serverUrl and reads exact health through V2", async () => {
    const fake = fixture();
    expect(await fake.adapter.readHealth()).toEqual({ healthy: true, version: "1.18.21" });
    expect(fake.calls).toEqual([
      {
        surface: "createV2",
        input: { baseUrl: "http://127.0.0.1:4321/", directory: "/workspace" },
      },
      { surface: "health" },
    ]);
  });

  test("uses V2 metadata and injected legacy root, archive, and status surfaces", async () => {
    const visibleRoots = [
      nativeSession("ses_idle", "legacy idle", 10),
      nativeSession("ses_busy", "legacy busy", 20),
      nativeSession("ses_retry", "stale visible retry", 29),
    ];
    const archivedRoots = [
      nativeSession("ses_retry", "legacy retry", 30, 25),
      nativeSession("ses_unknown", "legacy unknown", 40),
    ];
    const roots = [...visibleRoots, ...archivedRoots];
    const fake = fixture({
      visibleRoots,
      archivedRoots,
      listed: roots.map((item) => ({
        ...item,
        title: `V2 ${item.id}`,
        time: { ...item.time, updated: item.time.updated + 1 },
      })),
      statuses: {
        ses_busy: { type: "busy" },
        ses_retry: { type: "retry", attempt: 2, message: "again", next: 9000 },
        ses_unknown: { type: "retry", attempt: "bad", message: "again", next: 9000 },
      },
    });
    const observations = await fake.adapter.readVisibleRoots(true);
    expect(
      observations.map((observation) => ({ ...observation, id: String(observation.id) })),
    ).toEqual([
      {
        id: "ses_idle",
        title: "V2 ses_idle",
        updatedAtMs: 11,
        isArchived: false,
        status: "idle",
        observedAtMs: 7000,
      },
      {
        id: "ses_busy",
        title: "V2 ses_busy",
        updatedAtMs: 21,
        isArchived: false,
        status: "busy",
        observedAtMs: 7000,
      },
      {
        id: "ses_retry",
        title: "V2 ses_retry",
        updatedAtMs: 31,
        isArchived: true,
        status: "retry",
        observedAtMs: 7000,
      },
      {
        id: "ses_unknown",
        title: "V2 ses_unknown",
        updatedAtMs: 41,
        isArchived: true,
        status: "unknown",
        observedAtMs: 7000,
      },
    ]);
    expect(fake.calls).toContainEqual({
      surface: "legacy.roots",
      input: { roots: true, archived: true, directory: "/workspace" },
    });
    expect(fake.calls).toContainEqual({
      surface: "legacy.roots",
      input: { roots: true, archived: false, directory: "/workspace" },
    });
    expect(fake.calls.filter((call) => call.surface === "legacy.roots")).toHaveLength(2);
    expect(fake.calls).toContainEqual({
      surface: "v2.list",
      input: { directory: "/workspace", limit: 100, order: "desc" },
    });
    expect(fake.calls.filter((call) => call.surface === "v2.active")).toHaveLength(1);
  });

  test("merges legacy-owned and V2-owned activity with authoritative precedence", async () => {
    const roots = [
      nativeSession("ses_v2", "v2", 1),
      nativeSession("ses_legacyBusy", "busy", 2),
      nativeSession("ses_legacyRetry", "retry", 3),
      nativeSession("ses_conflict", "conflict", 4),
      nativeSession("ses_unknown", "unknown", 5),
      nativeSession("ses_malformedActive", "malformed active", 6),
      nativeSession("ses_idle", "idle", 7),
    ];
    const fake = fixture({
      visibleRoots: roots,
      statuses: {
        ses_legacyBusy: { type: "busy" },
        ses_legacyRetry: { type: "retry", attempt: 1, message: "later", next: 9 },
        ses_conflict: { type: "retry", attempt: 2, message: "legacy wins", next: 10 },
        ses_unknown: { type: "retry", attempt: "bad", message: "bad", next: 10 },
        ses_malformedActive: { type: "something" },
      },
      active: {
        ses_v2: { type: "running" },
        ses_conflict: { type: "running" },
        ses_unknown: { type: "running" },
        ses_malformedActive: { type: "stopped" },
      },
    });
    const observations = await fake.adapter.readVisibleRoots(false);
    expect(observations.map(({ id, status }) => ({ id: String(id), status }))).toEqual([
      { id: "ses_v2", status: "busy" },
      { id: "ses_legacyBusy", status: "busy" },
      { id: "ses_legacyRetry", status: "retry" },
      { id: "ses_conflict", status: "retry" },
      { id: "ses_unknown", status: "busy" },
      { id: "ses_malformedActive", status: "unknown" },
      { id: "ses_idle", status: "idle" },
    ]);
  });

  test("requests non-archived roots by default and falls back to legacy display metadata", async () => {
    const fake = fixture({ visibleRoots: [nativeSession("ses_root", "legacy title", 22)] });
    expect(await fake.adapter.readVisibleRoots(false)).toMatchObject([
      { id: "ses_root", title: "legacy title", isArchived: false, status: "idle" },
    ]);
    expect(fake.calls).toContainEqual({
      surface: "legacy.roots",
      input: { roots: true, archived: false, directory: "/workspace" },
    });
    expect(fake.calls.filter((call) => call.surface === "legacy.roots")).toHaveLength(1);
  });
});

describe("OpenCode 1.18.21 native adapter failure boundaries and membership", () => {
  test.each([
    ["native error", { error: { credential: "secret" } }],
    ["missing data", { response: {} }],
    ["non-envelope", null],
  ])("rejects %s health responses as native faults", async (_label, response) => {
    const dependencies: OpenCodeNativeAdapterDependencies = {
      createV2Client: () => ({
        global: {
          async health(): Promise<unknown> {
            return response;
          },
        },
        v2: {
          session: {
            async active(): Promise<unknown> {
              return envelope({ data: {} });
            },
            async list(): Promise<unknown> {
              return envelope({ data: [], cursor: {} });
            },
            async prompt(): Promise<unknown> {
              return envelope({ data: {} });
            },
          },
        },
      }),
    };
    const client = {
      experimental: { session: { list: async () => envelope([]) } },
      session: { status: async () => envelope({}) },
    };
    const adapter = createOpenCode11821NativeAdapter(
      {
        client,
        directory: "/workspace",
        serverUrl: new URL("http://localhost/"),
        workspaceKey,
      },
      dependencies,
    );
    await expect(adapter.readHealth()).rejects.toThrow();
  });

  test.each([
    ["malformed root list", { visibleRoots: {}, listed: [], statuses: {} }],
    ["malformed status map", { visibleRoots: [], listed: [], statuses: [] }],
    [
      "malformed root ID",
      { visibleRoots: [nativeSession("bad", "title", 1)], listed: [], statuses: {} },
    ],
    [
      "malformed update",
      {
        visibleRoots: [{ id: "ses_root", title: "title", time: { updated: "now" } }],
        listed: [],
        statuses: {},
      },
    ],
    [
      "malformed archive",
      {
        visibleRoots: [{ id: "ses_root", title: "title", time: { updated: 1, archived: "yes" } }],
        listed: [],
        statuses: {},
      },
    ],
    ["malformed V2 entry", { visibleRoots: [], listed: [{ id: "ses_bad" }], statuses: {} }],
    ["malformed active envelope", { visibleRoots: [], active: [] }],
  ])("rejects %s", async (_label, options) => {
    await expect(fixture(options).adapter.readVisibleRoots(false)).rejects.toThrow();
  });

  test("fails during construction when required injected legacy surfaces are absent", () => {
    const dependencies: OpenCodeNativeAdapterDependencies = {
      createV2Client: () => ({
        global: { health: async () => envelope({ healthy: true, version: "1.18.21" }) },
        v2: {
          session: {
            active: async () => envelope({ data: {} }),
            list: async () => envelope({ data: [], cursor: {} }),
            prompt: async () => envelope({ data: {} }),
          },
        },
      }),
    };
    expect(() =>
      createOpenCode11821NativeAdapter(
        {
          client: {},
          directory: "/workspace",
          serverUrl: new URL("http://localhost/"),
          workspaceKey,
        },
        dependencies,
      ),
    ).toThrow();
  });

  test("reads current visible roots for only the bound workspace", async () => {
    const fake = fixture({
      visibleRoots: [
        nativeSession("ses_source", "Source title", 1),
        nativeSession("ses_target", "Target", 2),
      ],
    });
    const source = valid(validateSessionId("ses_source"));
    expect(await fake.adapter.readCurrentRoots(workspaceKey, source, targetSessionId)).toEqual({
      sourceVisible: true,
      targetVisible: true,
      sourceTitle: "Source title",
    });
    expect(fake.calls.at(-1)).toEqual({
      surface: "legacy.roots",
      input: { roots: true, archived: false, directory: "/workspace" },
    });
    const foreign = valid(validateWorkspaceKey("workspace:foreign"));
    await expect(fake.adapter.readCurrentRoots(foreign, source, targetSessionId)).rejects.toThrow();
    expect(fake.calls.filter((call) => call.surface === "legacy.roots")).toHaveLength(1);
  });
});

describe("OpenCode 1.18.21 native queue admission", () => {
  test("queues exactly once and accepts exact admission evidence using native time", async () => {
    const controller = new AbortController();
    const fake = fixture({
      promptResponse: envelope({
        data: {
          admittedSeq: 4,
          id: nativeMessageId,
          sessionID: targetSessionId,
          prompt: { text: "verified envelope" },
          delivery: "queue",
          timeCreated: 1234,
        },
      }),
    });
    expect(
      await fake.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: controller.signal,
      }),
    ).toEqual({ kind: "admitted", admittedSeq: 4, observedAtMs: 1234 });
    expect(fake.calls.filter((call) => call.surface === "v2.prompt")).toEqual([
      {
        surface: "v2.prompt",
        input: [
          {
            sessionID: "ses_target",
            id: `msg_${"a".repeat(32)}`,
            prompt: { text: "verified envelope" },
            delivery: "queue",
            resume: true,
          },
          { signal: controller.signal },
        ],
      },
    ]);
  });

  test("accepts promotion and falls back to the clock only when native time is absent", async () => {
    const fake = fixture({
      promptResponse: envelope({
        data: {
          admittedSeq: 4,
          promotedSeq: 7,
          id: nativeMessageId,
          sessionID: targetSessionId,
          prompt: { text: "verified envelope" },
          delivery: "queue",
        },
      }),
    });
    expect(
      await fake.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: new AbortController().signal,
      }),
    ).toEqual({ kind: "promoted", admittedSeq: 4, promotedSeq: 7, observedAtMs: 7000 });
  });

  test("preserves coherent admission when abort wins only after the response is returned", async () => {
    const controller = new AbortController();
    const admission = {
      admittedSeq: 4,
      id: nativeMessageId,
      sessionID: targetSessionId,
      prompt: { text: "verified envelope" },
      delivery: "queue",
      get timeCreated() {
        controller.abort();
        return 12;
      },
    };
    const fake = fixture({
      promptResponse: envelope({ data: admission }),
    });
    expect(
      await fake.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: controller.signal,
      }),
    ).toEqual({ kind: "admitted", admittedSeq: 4, observedAtMs: 12 });
    expect(controller.signal.aborted).toBe(true);
  });

  test.each([
    ["mismatched session", { sessionID: "ses_other" }],
    ["mismatched ID", { id: `msg_${"b".repeat(32)}` }],
    ["wrong delivery", { delivery: "steer" }],
    ["mismatched text", { prompt: { text: "other" } }],
    ["negative sequence", { admittedSeq: -1 }],
    ["unsafe sequence", { admittedSeq: Number.MAX_SAFE_INTEGER + 1 }],
    ["invalid promotion", { promotedSeq: 4 }],
    ["invalid native time", { timeCreated: Number.NaN }],
  ])("returns unknown for %s evidence", async (_label, replacement) => {
    const fake = fixture({
      promptResponse: envelope({
        data: {
          admittedSeq: 4,
          promotedSeq: 5,
          id: nativeMessageId,
          sessionID: targetSessionId,
          prompt: { text: "verified envelope" },
          delivery: "queue",
          timeCreated: 10,
          ...replacement,
        },
      }),
    });
    expect(
      await fake.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: new AbortController().signal,
      }),
    ).toEqual({ kind: "unknown" });
  });

  test.each([
    ["transport throw", { promptThrows: true }],
    ["malformed envelope", { promptResponse: null }],
    [
      "server rejection",
      { promptResponse: { error: {}, response: new Response(null, { status: 503 }) } },
    ],
    ["ambiguous error", { promptResponse: { error: {} } }],
    ["untrusted status object", { promptResponse: { error: {}, response: { status: 404 } } }],
  ])("returns unknown without retry for %s", async (_label, options) => {
    const fake = fixture(options);
    expect(
      await fake.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: new AbortController().signal,
      }),
    ).toEqual({ kind: "unknown" });
    expect(fake.calls.filter((call) => call.surface === "v2.prompt")).toHaveLength(1);
  });

  test("returns definitive rejection only for completed 4xx while not aborted", async () => {
    const fake = fixture({
      promptResponse: {
        error: { _tag: "SessionNotFoundError", sessionID: targetSessionId, message: "not found" },
        response: new Response(null, { status: 404 }),
      },
    });
    expect(
      await fake.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: new AbortController().signal,
      }),
    ).toEqual({ kind: "definitive_rejection" });

    const controller = new AbortController();
    controller.abort();
    const aborted = fixture({
      promptResponse: { error: { name: "bad request" }, response: { status: 400 } },
    });
    expect(
      await aborted.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: controller.signal,
      }),
    ).toEqual({ kind: "unknown" });
    expect(aborted.calls.filter((call) => call.surface === "v2.prompt")).toHaveLength(0);

    const racedController = new AbortController();
    const raced = fixture({
      onPrompt: () => racedController.abort(),
      promptResponse: {
        error: { name: "bad request" },
        response: new Response(null, { status: 400 }),
      },
    });
    expect(
      await raced.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: racedController.signal,
      }),
    ).toEqual({ kind: "unknown" });
  });
});
