import { describe, expect, test } from "bun:test";

import {
  createOpenCode11821NativeAdapter,
  type OpenCodeNativeAdapterDependencies,
} from "../../../../src/adapters/native/opencode-1-18-21";

interface FixtureOptions {
  readonly health?: unknown;
  readonly listed?: unknown;
  readonly visibleRoots?: unknown;
  readonly archivedRoots?: unknown;
  readonly statuses?: unknown;
}

function envelope(data: unknown): { readonly data: unknown } {
  return { data };
}

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
            async list(input): Promise<unknown> {
              calls.push({ surface: "v2.list", input });
              return envelope({ data: options.listed ?? [], cursor: {} });
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
      { client, directory: "/workspace", serverUrl: new URL("http://127.0.0.1:4321/") },
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
            async list(): Promise<unknown> {
              return envelope({ data: [], cursor: {} });
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
      { client, directory: "/workspace", serverUrl: new URL("http://localhost/") },
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
  ])("rejects %s", async (_label, options) => {
    await expect(fixture(options).adapter.readVisibleRoots(false)).rejects.toThrow();
  });

  test("fails during construction when required injected legacy surfaces are absent", () => {
    const dependencies: OpenCodeNativeAdapterDependencies = {
      createV2Client: () => ({
        global: { health: async () => envelope({ healthy: true, version: "1.18.21" }) },
        v2: { session: { list: async () => envelope({ data: [], cursor: {} }) } },
      }),
    };
    expect(() =>
      createOpenCode11821NativeAdapter(
        { client: {}, directory: "/workspace", serverUrl: new URL("http://localhost/") },
        dependencies,
      ),
    ).toThrow();
  });
});
