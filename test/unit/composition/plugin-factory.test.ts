import { describe, expect, spyOn, test } from "bun:test";
import type { OpenCodeNativeAdapter } from "../../../src/adapters/native/opencode-2";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import { createCompositionFactory } from "../../../src/composition/plugin";
import { communicatorToolIds } from "../../../src/composition/tools";
import { domainFailure } from "../../../src/domain/results";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("workspace");
if (!workspace.ok) throw new Error("Invalid workspace fixture.");

function pluginContext(options: object = {}) {
  return {
    options,
    location: { project: { canonical: "/workspace" }, directory: "/workspace" },
  } as never;
}

function incompatibleNative(): OpenCodeNativeAdapter {
  return {
    readHealth: async () => ({ healthy: true, version: "wrong" }),
    readVisibleRoots: async () => [],
    readCurrentRoots: async () => ({
      sourceVisible: false,
      targetVisible: false,
      sourceTitle: undefined,
    }),
    readMessagePage: async () => ({
      messages: [],
      examinedMessageIds: [],
      examinedMessageCount: 0,
      projectedTextByteCount: 0,
      rawResponseByteCount: 0,
      examinedPartCount: 0,
      previousCursor: null,
      nextCursor: null,
    }),
    readMessage: async () => ({ kind: "not_found", rawResponseByteCount: 0 }),
    queueMessage: async () => ({ kind: "unknown" }),
    steerRequest: async () => ({ kind: "unknown" }),
    observeRequestParticipants: async () => ({
      sourceVisible: false,
      targetVisible: false,
      targetStatus: "unknown",
    }),
    observeParticipantActivities: async (_workspace, sessionIds) =>
      sessionIds.map((sessionId) => ({ sessionId, activity: "unknown" as const })),
    interruptSession: async () => "unknown",
    createRootSession: async () => "unknown",
    reconcileRootSession: async () => "unknown",
    updateSessionTitle: async () => "unknown",
    admitInitialMessage: async () => "unknown",
    readParticipantPresence: async () => "present",
    isEligibleContextTarget: async () => true,
    revalidateRoot: async () => undefined,
  };
}

describe("composition factory ordering", () => {
  test("proves exact host compatibility before opening any store", async () => {
    const order: string[] = [];
    const plugin = createCompositionFactory({
      runtimeIdentity: {
        readIdentity() {
          order.push("runtime");
          return { platform: "linux", architecture: "x64", bunVersion: "1.4.0" };
        },
      },
      parseOptions(value) {
        order.push("config");
        return parseCommunicatorOptions(value, { HOME: "/home/operator" });
      },
      deriveWorkspace() {
        order.push("workspace");
        return {
          workspaceKey: workspace.value,
          projectId: "project",
          directory: "/workspace",
          worktree: "/workspace",
        };
      },
      createHealth() {
        order.push("health-adapter");
        return { readHealth: async () => ({ healthy: true, version: "2.0.26" }) };
      },
      createNative() {
        order.push("native");
        return incompatibleNative();
      },
      async checkCompatibility(runtimeIdentity) {
        order.push("compatibility");
        runtimeIdentity.readIdentity();
        return domainFailure("incompatible_host", "incompatible", false);
      },
      createStore(): never {
        order.push("store");
        throw new Error("store must not open");
      },
    });
    await expect(plugin(pluginContext())).rejects.toThrow("incompatible");
    expect(order).toEqual(["config", "workspace", "health-adapter", "compatibility", "runtime"]);
  });

  test("rejects an incompatible runtime before health I/O or persistent resources", async () => {
    const order: string[] = [];
    const plugin = createCompositionFactory({
      runtimeIdentity: {
        readIdentity: () => ({ platform: "linux", architecture: "arm64", bunVersion: "1.4.0" }),
      },
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/workspace",
        worktree: "/workspace",
      }),
      createHealth: () => ({
        async readHealth(): Promise<unknown> {
          order.push("health-read");
          return { healthy: true, version: "2.0.26" };
        },
      }),
      createStore(): never {
        order.push("store");
        throw new Error("store must not open");
      },
    });

    await expect(plugin(pluginContext())).rejects.toThrow("requires Linux x64 and OpenCode 2.0.26");
    expect(order).toEqual([]);
  });

  test("includes the initial health proof in the startup deadline", async () => {
    let rejectLate: ((cause: unknown) => void) | undefined;
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/workspace",
        worktree: "/workspace",
      }),
      createHealth: () => ({
        readHealth: () =>
          new Promise((_resolve, reject) => {
            rejectLate = reject;
          }),
      }),
      createStore(): never {
        throw new Error("store must not open");
      },
    });
    await expect(plugin(pluginContext({ startupDeadlineMs: 5 }))).rejects.toThrow(
      "OpenCode v2 compatibility proof timed out",
    );
    rejectLate?.(new Error("late health rejection"));
    await Promise.resolve();
  });

  test("registers the exact 21-tool set only after recovery and disposes through ordered cleanup", async () => {
    const order: string[] = [];
    const lifecycle = {
      fencingToken: 1 as never,
      status: "ready",
      effectSignal: new AbortController().signal,
      assertReady: () => undefined,
      observeStop: () => () => undefined,
      stop: () => order.push("lifecycle-stop"),
      scheduler: { drain: async () => order.push("scheduler-drain") },
    };
    const store = {
      starts: {},
      listParticipantDeletionCandidates: async () => ({
        ok: true,
        sessionIds: ["ses_deleted"],
      }),
      deleteParticipantRequests: async () => {
        order.push("participant-delete");
        return { ok: true, terminalized: [] };
      },
      deleteAbsentParticipantRequests: async () => ({ ok: true, terminalized: [] }),
      failPendingContextForParticipant: async () => [],
      settlePendingContextForParticipant: async () => [],
      close: () => order.push("store-close"),
    };
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/workspace",
        worktree: "/workspace",
      }),
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
      createNative: () => ({
        ...incompatibleNative(),
        readParticipantPresence: async () => "absent" as const,
      }),
      createStore: () => store as never,
      createRuntime: () =>
        ({
          effectSignal: new AbortController().signal,
          stop: () => order.push("runtime-stop"),
        }) as never,
      recoverStartup: async () => {
        order.push("recovery");
        return { ok: true, value: lifecycle as never };
      },
      recoverContextStartup: async () => undefined,
      createExporter: () => ({
        adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
        drain: async () => {
          order.push("exporter-drain");
        },
        dispose: () => order.push("exporter-dispose"),
      }),
    });
    const hooks = await plugin(pluginContext());
    expect(order).toEqual(["recovery"]);
    expect(Object.keys(hooks.tool ?? {})).toEqual([...communicatorToolIds]);
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(21);
    await hooks.event?.({
      event: {
        id: "evt_deleted",
        created: 1,
        type: "session.deleted",
        durable: { aggregateID: "ses_deleted", seq: 1, version: 2 },
        location: { directory: "/workspace" },
        data: { sessionID: "ses_deleted" },
      },
    });
    expect(order).toEqual(["recovery", "participant-delete"]);
    await hooks.dispose?.();
    expect(order).toEqual([
      "recovery",
      "participant-delete",
      "lifecycle-stop",
      "scheduler-drain",
      "exporter-drain",
      "exporter-dispose",
      "store-close",
    ]);
  });
});

describe("composition factory failure cleanup", () => {
  test("isolates exporter construction failure after recovery", async () => {
    const order: string[] = [];
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/workspace",
        worktree: "/workspace",
      }),
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
      createNative: () => incompatibleNative(),
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
      createRuntime: () =>
        ({
          effectSignal: new AbortController().signal,
          stop: () => order.push("runtime-stop"),
        }) as never,
      recoverStartup: async () => ({
        ok: true,
        value: {
          fencingToken: 1 as never,
          status: "ready",
          stopState: undefined,
          effectSignal: new AbortController().signal,
          assertReady: () => undefined,
          observeStop: () => () => undefined,
          stop: () => order.push("lifecycle-stop"),
          scheduler: {
            drain: async () => {
              await Promise.resolve();
              order.push("scheduler-drain");
            },
          },
        } as never,
      }),
      recoverContextStartup: async () => undefined,
      createExporter: () => {
        throw new Error("post-recovery failure");
      },
    });
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const hooks = await plugin(pluginContext());
      expect(Object.keys(hooks.tool ?? {})).toEqual([...communicatorToolIds]);
      expect(warning).toHaveBeenCalledWith(
        "Session export is unavailable because secure initialization failed.",
      );
      await hooks.dispose?.();
    } finally {
      warning.mockRestore();
    }
    expect(order).toEqual(["lifecycle-stop", "scheduler-drain", "store-close"]);
  });

  test("rolls back the runtime and store when startup recovery rejects construction", async () => {
    const order: string[] = [];
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/workspace",
        worktree: "/workspace",
      }),
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
      createNative: () => incompatibleNative(),
      createStore: () => ({ close: () => order.push("store-close") }) as never,
      createRuntime: () =>
        ({
          effectSignal: new AbortController().signal,
          stop: () => order.push("runtime-stop"),
        }) as never,
      recoverStartup: async () => domainFailure("storage_unavailable", "recovery failed", true),
    });

    await expect(plugin(pluginContext())).rejects.toThrow(
      "storage became unavailable during recovery",
    );
    expect(order).toEqual(["runtime-stop", "store-close"]);
  });

  test("continues ordered disposal after a failure and rethrows only the first failure", async () => {
    const order: string[] = [];
    const lifecycle = {
      fencingToken: 1 as never,
      status: "ready",
      stopState: undefined,
      effectSignal: new AbortController().signal,
      assertReady: () => undefined,
      observeStop: () => () => undefined,
      stop: () => {
        order.push("lifecycle-stop");
        throw new Error("first cleanup failure");
      },
      scheduler: { drain: async () => order.push("scheduler-drain") },
    };
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/workspace",
        worktree: "/workspace",
      }),
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
      createNative: () => incompatibleNative(),
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
      recoverStartup: async () => ({ ok: true, value: lifecycle as never }),
      recoverContextStartup: async () => undefined,
      createExporter: () => ({
        adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
        drain: async () => {
          order.push("exporter-drain");
        },
        dispose: () => {
          order.push("exporter-dispose");
          throw new Error("later cleanup failure");
        },
      }),
    });
    const hooks = await plugin(pluginContext());

    const first = hooks.dispose?.();
    const second = hooks.dispose?.();
    await expect(first).rejects.toThrow("first cleanup failure");
    await expect(second).rejects.toThrow("first cleanup failure");
    expect(order).toEqual([
      "lifecycle-stop",
      "scheduler-drain",
      "exporter-drain",
      "exporter-dispose",
      "store-close",
    ]);
  });

  test("drains exporter-owned work before disposing exporter and store resources", async () => {
    const order: string[] = [];
    let releaseDrain: (() => void) | undefined;
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/workspace",
        worktree: "/workspace",
      }),
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
      createNative: () => incompatibleNative(),
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
      recoverStartup: async () => ({
        ok: true,
        value: {
          status: "ready",
          stopState: undefined,
          effectSignal: new AbortController().signal,
          observeStop: () => () => undefined,
          stop: () => order.push("lifecycle-stop"),
          scheduler: { drain: async () => order.push("scheduler-drain") },
        } as never,
      }),
      recoverContextStartup: async () => undefined,
      createExporter: () => ({
        adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
        drain: () =>
          new Promise<void>((resolve) => {
            order.push("exporter-drain-start");
            releaseDrain = () => {
              order.push("exporter-drain-finish");
              resolve();
            };
          }),
        dispose: () => order.push("exporter-dispose"),
      }),
    });
    const hooks = await plugin(pluginContext());
    const disposal = hooks.dispose?.();
    while (!releaseDrain) await Promise.resolve();
    expect(order).toEqual(["lifecycle-stop", "scheduler-drain", "exporter-drain-start"]);
    releaseDrain();
    await disposal;
    expect(order).toEqual([
      "lifecycle-stop",
      "scheduler-drain",
      "exporter-drain-start",
      "exporter-drain-finish",
      "exporter-dispose",
      "store-close",
    ]);
  });
});
