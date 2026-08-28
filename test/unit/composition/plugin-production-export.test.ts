import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenCodeNativeAdapter } from "../../../src/adapters/native/opencode-1-18";
import {
  type CommunicatorOptions,
  parseCommunicatorOptions,
} from "../../../src/composition/config";
import {
  type CompositionDependencies,
  createCompositionFactory,
  productionExportEnvironment,
} from "../../../src/composition/plugin";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const parsedWorkspaceKey = validateWorkspaceKey(`wrk_${"a".repeat(64)}`);
if (!parsedWorkspaceKey.ok) throw new Error("Invalid workspace fixture.");
const workspaceKey = parsedWorkspaceKey.value;

const roots: string[] = [];

function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "communicator-composition-export-"));
  chmodSync(root, 0o700);
  mkdirSync(join(root, "workspace"), { mode: 0o700 });
  roots.push(root);
  return root;
}

function nativeFixture(): OpenCodeNativeAdapter {
  return {
    readHealth: async () => ({ healthy: true, version: "1.18.23" }),
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
    interruptSession: async () => "unknown",
    createRootSession: async () => "unknown",
    reconcileRootSession: async () => "unknown",
    updateSessionTitle: async () => "unknown",
    admitInitialMessage: async () => "unknown",
    readParticipantPresence: async () => "present",
  };
}

function lifecycle(order: string[]) {
  return {
    fencingToken: 1 as never,
    assertReady: () => undefined,
    stop: () => order.push("lifecycle-stop"),
    scheduler: { drain: async () => order.push("scheduler-drain") },
  };
}

function injectedDependencies(
  options: CommunicatorOptions,
  order: string[],
): Partial<CompositionDependencies> {
  return {
    parseOptions: () => options,
    deriveWorkspace: () => ({
      workspaceKey,
      projectId: "project",
      directory: join(options.stateDirectory, "..", "workspace"),
      worktree: join(options.stateDirectory, "..", "workspace"),
    }),
    createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "1.18.23" }) }),
    checkCompatibility: async () => ({ ok: true, value: { version: "1.18.23" } }),
    createNative: nativeFixture,
    createRuntime: () => ({ stop: () => order.push("runtime-stop") }) as never,
    recoverStartup: async () => ({ ok: true, value: lifecycle(order) as never }),
  };
}

function openDescriptorCount(path: string): number {
  return readdirSync("/proc/self/fd").filter((descriptor) => {
    try {
      return readlinkSync(join("/proc/self/fd", descriptor)) === path;
    } catch {
      return false;
    }
  }).length;
}

function pluginInput() {
  return {
    client: {},
    directory: "/ignored",
    worktree: "/ignored",
    serverUrl: new URL("http://x"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production composition resources", () => {
  test("passes only allowlisted host state variables to the production exporter", () => {
    expect(
      productionExportEnvironment({
        HOME: "/custom/home",
        XDG_DATA_HOME: "/custom/data",
        XDG_STATE_HOME: "/custom/state",
        LANG: "en_US.UTF-8",
        NODE_OPTIONS: "--require=/rejected",
        LD_PRELOAD: "/rejected.so",
        OPENCODE_CONFIG: "/rejected.json",
        PATH: "/rejected/bin",
      }),
    ).toEqual({
      HOME: "/custom/home",
      XDG_DATA_HOME: "/custom/data",
      XDG_STATE_HOME: "/custom/state",
      LANG: "en_US.UTF-8",
    });
  });

  test("opens the real store and initializes the unavailable exporter when export is unconfigured", async () => {
    const root = rootFixture();
    const order: string[] = [];
    const options = parseCommunicatorOptions(
      { stateDirectory: join(root, "state") },
      { HOME: root },
    );
    const plugin = createCompositionFactory(injectedDependencies(options, order));

    const hooks = await Reflect.apply(plugin, undefined, [pluginInput(), {}]);
    expect(readdirSync(options.stateDirectory)).toContain(`${workspaceKey.slice(0, 56)}.sqlite3`);
    await hooks.dispose?.();
    expect(order).toEqual(["lifecycle-stop", "scheduler-drain"]);
  });

  test("initializes and disposes the real configured exporter with every bounded limit", async () => {
    const root = rootFixture();
    const exportRoot = join(root, "exports");
    const order: string[] = [];
    const options = parseCommunicatorOptions(
      {
        stateDirectory: join(root, "state"),
        export: {
          root: exportRoot,
          executable: "/usr/bin/true",
          trustedWorkingDirectory: "/usr/bin",
          limits: {
            maximumOutputBytes: 4_096,
            maximumStderrBytes: 128,
            maximumDurationMs: 1_000,
            maximumConcurrent: 1,
            terminationGraceMs: 5_000,
            maximumSourceExportsPerMinute: 2,
            maximumWorkspaceExportsPerMinute: 3,
          },
        },
      },
      { HOME: root },
    );
    const dependencies = {
      ...injectedDependencies(options, order),
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
    };
    const hooks = await Reflect.apply(createCompositionFactory(dependencies), undefined, [
      pluginInput(),
      {},
    ]);

    expect(openDescriptorCount(exportRoot)).toBe(1);
    await hooks.dispose?.();
    expect(openDescriptorCount(exportRoot)).toBe(0);
    expect(order).toEqual(["lifecycle-stop", "scheduler-drain", "store-close"]);
  });

  test("isolates configured exporter initialization failure from all communication tools", async () => {
    const root = rootFixture();
    const order: string[] = [];
    const options = parseCommunicatorOptions(
      {
        stateDirectory: join(root, "state"),
        export: {
          root: join(root, "exports"),
          executable: "/etc/passwd",
          trustedWorkingDirectory: "/usr/bin",
        },
      },
      { HOME: root },
    );
    const dependencies = {
      ...injectedDependencies(options, order),
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
    };

    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const hooks = await Reflect.apply(createCompositionFactory(dependencies), undefined, [
        pluginInput(),
        {},
      ]);
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(14);
      expect(warning).toHaveBeenCalledWith(
        "Session export is unavailable because secure initialization failed.",
      );
      expect(warning.mock.calls.flat().join(" ")).not.toContain(root);
      await hooks.dispose?.();
      expect(order).toEqual(["lifecycle-stop", "scheduler-drain", "store-close"]);
    } finally {
      warning.mockRestore();
    }
  });
});
