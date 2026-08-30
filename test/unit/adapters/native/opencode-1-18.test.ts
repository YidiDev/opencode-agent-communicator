import { describe, expect, test } from "bun:test";

import {
  createOpenCode118NativeAdapter,
  type OpenCodeNativeAdapterDependencies,
} from "../../../../src/adapters/native/opencode-1-18";
import {
  validateManagedSessionId,
  validateNativeMessageId,
} from "../../../../src/domain/generated-ids";
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
  readonly interruptResponse?: unknown;
  readonly interruptThrows?: boolean;
  readonly startGets?: unknown[];
  readonly startCreateResponse?: unknown;
  readonly titleUpdateResponse?: unknown;
  readonly publicPromptResponse?: unknown;
  readonly publicMessageResponse?: unknown;
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
const managedSessionId = valid(validateManagedSessionId(`ses_${"b".repeat(32)}`));

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
            return envelope(options.health ?? { healthy: true, version: "1.18.23" });
          },
        },
        experimental: {
          session: {
            async list(input: unknown): Promise<unknown> {
              calls.push({ surface: "legacy.roots", input });
              const isArchived =
                typeof input === "object" &&
                input !== null &&
                Reflect.get(input, "archived") === true;
              return envelope(
                isArchived ? (options.archivedRoots ?? []) : (options.visibleRoots ?? []),
              );
            },
          },
        },
        session: {
          async update(input, requestOptions): Promise<unknown> {
            calls.push({ surface: "public.update", input: [input, requestOptions] });
            return options.titleUpdateResponse;
          },
          async promptAsync(input: unknown, requestOptions: unknown): Promise<unknown> {
            calls.push({ surface: "public.promptAsync", input: [input, requestOptions] });
            return options.publicPromptResponse;
          },
          async message(input: unknown, requestOptions: unknown): Promise<unknown> {
            calls.push({ surface: "public.message", input: [input, requestOptions] });
            return options.publicMessageResponse;
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
            async create(input, requestOptions): Promise<unknown> {
              calls.push({ surface: "v2.create", input: [input, requestOptions] });
              return options.startCreateResponse;
            },
            async get(input, requestOptions): Promise<unknown> {
              calls.push({ surface: "v2.get", input: [input, requestOptions] });
              return options.startGets?.shift();
            },
          },
        },
      };
    },
  };
  const client = {
    session: {
      async list(input: unknown): Promise<unknown> {
        calls.push({ surface: "legacy.roots", input });
        return envelope(options.visibleRoots ?? []);
      },
      async status(input: unknown): Promise<unknown> {
        calls.push({ surface: "legacy.status", input });
        return envelope(options.statuses ?? {});
      },
      async abort(input: unknown, requestOptions: unknown): Promise<unknown> {
        calls.push({ surface: "legacy.abort", input: [input, requestOptions] });
        if (options.interruptThrows) throw new Error("private interrupt transport detail");
        return options.interruptResponse ?? envelope(true);
      },
      async update(input: unknown, requestOptions: unknown): Promise<unknown> {
        calls.push({ surface: "legacy.update", input: [input, requestOptions] });
        return options.titleUpdateResponse;
      },
    },
  };
  return {
    calls,
    adapter: createOpenCode118NativeAdapter(
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

function startedSession(title = "Worker") {
  return {
    id: managedSessionId,
    title,
    location: { directory: "/workspace" },
    time: { created: 1, updated: 1 },
  };
}

test("interrupts through the exact 1.18.23 legacy abort surface and preserves ambiguity", async () => {
  const successful = fixture();
  expect(
    await successful.adapter.interruptSession({
      targetSessionId,
      abort: new AbortController().signal,
    }),
  ).toBe("interrupted");
  const call = successful.calls.at(-1);
  expect(call?.surface).toBe("legacy.abort");
  if (!call || !Array.isArray(call.input)) throw new Error("interrupt call was not captured");
  expect(call.input[0]).toEqual({ sessionID: "ses_target", directory: "/workspace" });
  for (const options of [{ interruptResponse: envelope(false) }, { interruptThrows: true }]) {
    const ambiguous = fixture(options);
    expect(
      await ambiguous.adapter.interruptSession({
        targetSessionId,
        abort: new AbortController().signal,
      }),
    ).toBe("unknown");
  }
  const timedOut = fixture();
  const timeout = new AbortController();
  timeout.abort("deadline");
  expect(await timedOut.adapter.interruptSession({ targetSessionId, abort: timeout.signal })).toBe(
    "unknown",
  );
  expect(timedOut.calls.some((item) => item.surface === "legacy.abort")).toBe(false);
});

test("revalidates one exact visible participant activity for stop reconciliation", async () => {
  const busy = fixture({
    visibleRoots: [nativeSession("ses_target", "target", 2)],
    statuses: { ses_target: { type: "busy" } },
  });
  expect(
    await busy.adapter.observeParticipantActivities(
      workspaceKey,
      [targetSessionId, sourceSessionId],
      new AbortController().signal,
    ),
  ).toEqual([
    { sessionId: targetSessionId, activity: "busy" },
    { sessionId: sourceSessionId, activity: "not_visible" },
  ]);
  const absent = fixture({ visibleRoots: [] });
  expect(
    await absent.adapter.observeParticipantActivities(
      workspaceKey,
      [targetSessionId],
      new AbortController().signal,
    ),
  ).toEqual([{ sessionId: targetSessionId, activity: "not_visible" }]);
  const abort = new AbortController();
  abort.abort("disposed");
  expect(
    await absent.adapter.observeParticipantActivities(
      workspaceKey,
      [targetSessionId],
      abort.signal,
    ),
  ).toEqual([{ sessionId: targetSessionId, activity: "unknown" }]);
  await expect(
    busy.adapter.observeParticipantActivities(
      valid(validateWorkspaceKey("workspace:other")),
      [targetSessionId],
      new AbortController().signal,
    ),
  ).rejects.toThrow("binding");
});

describe("OpenCode 1.18.23 native adapter", () => {
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
});

describe("OpenCode 1.18.23 session read presence", () => {
  test("observes abort-aware session read presence as one exact native snapshot", async () => {
    const fake = fixture({
      visibleRoots: [
        nativeSession("ses_source", "source", 1),
        nativeSession("ses_target", "target", 2),
      ],
      statuses: { ses_target: { type: "retry", attempt: 1, message: "later", next: 10 } },
      active: { ses_target: { type: "running" } },
    });
    const observe = fake.adapter.observeSessionReadPresence;
    if (!observe) throw new Error("session read presence operation is missing");
    const signal = new AbortController().signal;
    expect(await observe(workspaceKey, sourceSessionId, targetSessionId, signal)).toEqual({
      sourceVisible: true,
      targetVisible: true,
      targetStatus: "retry",
      observedAtMs: 7000,
    });
    expect(fake.calls.filter((call) => call.surface === "legacy.roots")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.surface === "legacy.status")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.surface === "v2.active")).toHaveLength(1);
    const statusIndex = fake.calls.findIndex((call) => call.surface === "legacy.status");
    const activeIndex = fake.calls.findIndex((call) => call.surface === "v2.active");
    const rootsIndex = fake.calls.findIndex((call) => call.surface === "legacy.roots");
    expect(rootsIndex).toBeGreaterThan(statusIndex);
    expect(rootsIndex).toBeGreaterThan(activeIndex);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      observe(workspaceKey, sourceSessionId, targetSessionId, aborted.signal),
    ).rejects.toThrow("aborted");
    await expect(
      observe(
        valid(validateWorkspaceKey("workspace:other")),
        sourceSessionId,
        targetSessionId,
        signal,
      ),
    ).rejects.toThrow("binding");
    await expect(observe(workspaceKey, "bad" as never, targetSessionId, signal)).rejects.toThrow(
      "identity",
    );
  });
});

describe("OpenCode 1.18.23 native adapter observations", () => {
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
    expect(await fake.adapter.readHealth()).toEqual({ healthy: true, version: "1.18.23" });
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
      input: { roots: true, directory: "/workspace" },
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
      input: { roots: true, directory: "/workspace" },
    });
    expect(fake.calls.filter((call) => call.surface === "legacy.roots")).toHaveLength(1);
  });
});

describe("OpenCode 1.18.23 native adapter failure boundaries and membership", () => {
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
      session: {
        status: async () => envelope({}),
        abort: async () => envelope(true),
      },
    };
    const adapter = createOpenCode118NativeAdapter(
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
        global: { health: async () => envelope({ healthy: true, version: "1.18.23" }) },
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
      createOpenCode118NativeAdapter(
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
      input: { roots: true, directory: "/workspace" },
    });
    const foreign = valid(validateWorkspaceKey("workspace:foreign"));
    await expect(fake.adapter.readCurrentRoots(foreign, source, targetSessionId)).rejects.toThrow();
    expect(fake.calls.filter((call) => call.surface === "legacy.roots")).toHaveLength(1);
  });
});

describe("OpenCode 1.18.23 native adapter start and validation boundaries", () => {
  test("rejects invalid observation clocks and malformed participant requests", async () => {
    const badClock = fixture({ visibleRoots: [nativeSession("ses_source", "Source", 1)] });
    const dependencies = { now: () => Number.NaN };
    const clockAdapter = createOpenCode118NativeAdapter(
      {
        client: {
          experimental: { session: { list: async () => envelope([]) } },
          session: {
            list: async () => envelope([]),
            status: async () => envelope({}),
            abort: async () => envelope(true),
          },
        },
        directory: "/workspace",
        serverUrl: new URL("http://localhost/"),
        workspaceKey,
      },
      {
        ...dependencies,
        createV2Client: () => ({
          global: { health: async () => envelope({ healthy: true }) },
          experimental: { session: { list: async () => envelope([]) } },
          v2: {
            session: {
              active: async () => envelope({ data: {} }),
              list: async () => envelope({ data: [], cursor: {} }),
              prompt: async () => envelope({ data: {} }),
            },
          },
        }),
      },
    );
    await expect(clockAdapter.readVisibleRoots(false)).rejects.toThrow("clock");
    const foreign = valid(validateWorkspaceKey("workspace:foreign"));
    await expect(
      badClock.adapter.observeRequestParticipants(
        foreign,
        sourceSessionId,
        targetSessionId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Workspace binding");
    await expect(
      badClock.adapter.observeRequestParticipants(
        workspaceKey,
        "bad" as never,
        targetSessionId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("identity");
  });

  test("delegates deterministic creation and verified title update to the pinned surfaces", async () => {
    const absent = {
      error: {
        _tag: "SessionNotFoundError",
        sessionID: managedSessionId,
        message: "not found",
      },
      response: new Response(null, { status: 404 }),
    };
    const created = { data: { data: startedSession() } };
    const fake = fixture({
      startGets: [absent, created],
      startCreateResponse: created,
      titleUpdateResponse: {
        data: {
          id: managedSessionId,
          directory: "/workspace",
          title: "Renamed",
        },
      },
    });
    const abort = new AbortController().signal;
    expect(await fake.adapter.createRootSession({ sessionId: managedSessionId, abort })).toBe(
      "created",
    );
    expect(
      await fake.adapter.updateSessionTitle({
        sessionId: managedSessionId,
        title: "Renamed",
        abort,
      }),
    ).toBe("updated");
    expect(fake.calls.some((call) => call.surface === "v2.create")).toBe(true);
    expect(fake.calls.some((call) => call.surface === "public.update")).toBe(true);
    expect(fake.calls.some((call) => call.surface === "legacy.update")).toBe(false);
  });
});

describe("OpenCode 1.18.23 public message admission", () => {
  const observedMessage = (text = "verified envelope") => ({
    data: {
      info: { id: nativeMessageId, sessionID: targetSessionId, role: "user" },
      parts: [
        {
          id: "prt_public",
          sessionID: targetSessionId,
          messageID: nativeMessageId,
          type: "text",
          text,
        },
      ],
    },
    response: new Response(null, { status: 200 }),
  });

  test("submits once and accepts exact fixed-message read-back", async () => {
    const controller = new AbortController();
    const fake = fixture({
      publicPromptResponse: { data: {}, response: new Response(null, { status: 204 }) },
      publicMessageResponse: observedMessage(),
    });
    expect(
      await fake.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: controller.signal,
      }),
    ).toEqual({ kind: "public_message", observedAtMs: 7000 });
    expect(fake.calls.filter((call) => call.surface === "public.promptAsync")).toEqual([
      {
        surface: "public.promptAsync",
        input: [
          {
            sessionID: targetSessionId,
            directory: "/workspace",
            messageID: nativeMessageId,
            parts: [{ type: "text", text: "verified envelope" }],
          },
          { signal: controller.signal },
        ],
      },
    ]);
    expect(fake.calls.filter((call) => call.surface === "v2.prompt")).toHaveLength(0);
  });

  test("fails closed for mismatched public transcript evidence", async () => {
    const fake = fixture({
      publicPromptResponse: { data: {}, response: new Response(null, { status: 204 }) },
      publicMessageResponse: observedMessage("other"),
    });
    expect(
      await fake.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: new AbortController().signal,
      }),
    ).toEqual({ kind: "unknown" });
    expect(fake.calls.filter((call) => call.surface === "public.promptAsync")).toHaveLength(1);
  });

  test("returns definitive rejection before read-back and does not submit when aborted", async () => {
    const rejected = fixture({
      publicPromptResponse: {
        error: { _tag: "InvalidRequestError", message: "invalid" },
        request: new Request("http://opencode.internal/session"),
        response: new Response(null, { status: 400 }),
      },
    });
    expect(
      await rejected.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: new AbortController().signal,
      }),
    ).toEqual({ kind: "definitive_rejection" });
    expect(rejected.calls.filter((call) => call.surface === "public.message")).toHaveLength(0);

    const controller = new AbortController();
    controller.abort();
    const aborted = fixture();
    expect(
      await aborted.adapter.queueMessage({
        targetSessionId,
        nativeMessageId,
        envelope: "verified envelope",
        abort: controller.signal,
      }),
    ).toEqual({ kind: "unknown" });
    expect(aborted.calls.filter((call) => call.surface === "public.promptAsync")).toHaveLength(0);
  });
});
