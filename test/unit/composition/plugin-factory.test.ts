import { describe, expect, spyOn, test } from "bun:test";
import type { OpenCodeNativeAdapter } from "../../../src/adapters/native/opencode-1-18";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import { createCompositionFactory } from "../../../src/composition/plugin";
import { communicatorToolIds } from "../../../src/composition/tools";
import { domainFailure } from "../../../src/domain/results";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("workspace");
if (!workspace.ok) throw new Error("Invalid workspace fixture.");

function incompatibleNative(): OpenCodeNativeAdapter {
  return {
    readHealth: async () => ({ healthy: true, version: "wrong" }),
    readVisibleRoots: async () => [],
    readCurrentRoots: async () => ({
      sourceVisible: false,
      targetVisible: false,
      sourceTitle: undefined,
    }),
    queueMessage: async () => ({ kind: "unknown" }),
    steerRequest: async () => ({ kind: "unknown" }),
    observeRequestParticipants: async () => ({
      sourceVisible: false,
      targetVisible: false,
      targetStatus: "unknown",
    }),
    observeParticipantActivity: async () => "unknown",
    interruptSession: async () => "unknown",
    createRootSession: async () => "unknown",
    reconcileRootSession: async () => "unknown",
    updateSessionTitle: async () => "unknown",
    admitInitialMessage: async () => "unknown",
    readParticipantPresence: async () => "present",
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
        return { readHealth: async () => ({ healthy: true, version: "1.18.23" }) };
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
    await expect(Reflect.apply(plugin, undefined, [{}, {}])).rejects.toThrow("incompatible");
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
          return { healthy: true, version: "1.18.23" };
        },
      }),
      createStore(): never {
        order.push("store");
        throw new Error("store must not open");
      },
    });

    await expect(Reflect.apply(plugin, undefined, [{}, {}])).rejects.toThrow(
      "requires Linux x64 and a healthy OpenCode >=1.18.21 <1.19.0 host",
    );
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
    await expect(Reflect.apply(plugin, undefined, [{}, { startupDeadlineMs: 5 }])).rejects.toThrow(
      "requires Linux x64 and a healthy OpenCode >=1.18.21 <1.19.0 host",
    );
    rejectLate?.(new Error("late health rejection"));
    await Promise.resolve();
  });

  test("registers the exact 20-tool set only after recovery and disposes through ordered cleanup", async () => {
    const order: string[] = [];
    const lifecycle = {
      fencingToken: 1 as never,
      status: "ready",
      assertReady: () => undefined,
      stop: () => order.push("lifecycle-stop"),
      scheduler: { drain: async () => order.push("scheduler-drain") },
    };
    const store = {
      starts: {},
      deleteParticipantRequests: async () => {
        order.push("participant-delete");
        return { ok: true, terminalized: [] };
      },
      deleteAbsentParticipantRequests: async () => ({ ok: true, terminalized: [] }),
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
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "1.18.23" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "1.18.23" } }),
      createNative: () => ({
        ...incompatibleNative(),
        readParticipantPresence: async () => "absent" as const,
      }),
      createStore: () => store as never,
      createRuntime: () => ({ stop: () => order.push("runtime-stop") }) as never,
      recoverStartup: async () => {
        order.push("recovery");
        return { ok: true, value: lifecycle as never };
      },
      createExporter: () => ({
        adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
        drain: async () => {
          order.push("exporter-drain");
        },
        dispose: () => order.push("exporter-dispose"),
      }),
    });
    const hooks = await Reflect.apply(plugin, undefined, [{}, {}]);
    expect(order).toEqual(["recovery"]);
    expect(Object.keys(hooks.tool ?? {})).toEqual([...communicatorToolIds]);
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(20);
    const config: { permission?: unknown; skills?: { paths: string[] } } = {};
    await hooks.config?.(config as never);
    expect(config.permission).toEqual({ session_stop: "ask" });
    expect(config.skills?.paths[0]).toEndWith("/skills");
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: {
          info: {
            id: "ses_deleted",
            projectID: "project",
            directory: "/workspace",
            title: "Deleted",
            version: "1.18.23",
            time: { created: 1, updated: 2 },
          },
        },
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
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "1.18.23" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "1.18.23" } }),
      createNative: () => incompatibleNative(),
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
      createRuntime: () => ({ stop: () => order.push("runtime-stop") }) as never,
      recoverStartup: async () => ({
        ok: true,
        value: {
          fencingToken: 1 as never,
          assertReady: () => undefined,
          stop: () => order.push("lifecycle-stop"),
          scheduler: {
            drain: async () => {
              await Promise.resolve();
              order.push("scheduler-drain");
            },
          },
        } as never,
      }),
      createExporter: () => {
        throw new Error("post-recovery failure");
      },
    });
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const hooks = await Reflect.apply(plugin, undefined, [{}, {}]);
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
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "1.18.23" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "1.18.23" } }),
      createNative: () => incompatibleNative(),
      createStore: () => ({ close: () => order.push("store-close") }) as never,
      createRuntime: () => ({ stop: () => order.push("runtime-stop") }) as never,
      recoverStartup: async () => domainFailure("storage_unavailable", "recovery failed", true),
    });

    await expect(Reflect.apply(plugin, undefined, [{}, {}])).rejects.toThrow("recovery failed");
    expect(order).toEqual(["runtime-stop", "store-close"]);
  });

  test("continues ordered disposal after a failure and rethrows only the first failure", async () => {
    const order: string[] = [];
    const lifecycle = {
      fencingToken: 1 as never,
      assertReady: () => undefined,
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
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "1.18.23" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "1.18.23" } }),
      createNative: () => incompatibleNative(),
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
      recoverStartup: async () => ({ ok: true, value: lifecycle as never }),
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
    const hooks = await Reflect.apply(plugin, undefined, [{}, {}]);

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
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "1.18.23" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "1.18.23" } }),
      createNative: () => incompatibleNative(),
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
      recoverStartup: async () => ({
        ok: true,
        value: {
          stop: () => order.push("lifecycle-stop"),
          scheduler: { drain: async () => order.push("scheduler-drain") },
        } as never,
      }),
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
    const hooks = await Reflect.apply(plugin, undefined, [{}, {}]);
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
