import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenCodeNativeAdapter } from "../../../src/adapters/native/opencode-2";
import {
  type CommunicatorOptions,
  parseCommunicatorOptions,
} from "../../../src/composition/config";
import {
  type CompositionDependencies,
  createCompositionFactory,
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
    readHealth: async () => ({ healthy: true, version: "2.0.26" }),
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

function lifecycle(order: string[]) {
  return {
    fencingToken: 1 as never,
    status: "ready",
    stopState: undefined,
    effectSignal: new AbortController().signal,
    assertReady: () => undefined,
    observeStop: () => () => undefined,
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
    createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
    checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
    createNative: nativeFixture,
    createRuntime: () =>
      ({
        effectSignal: new AbortController().signal,
        stop: () => order.push("runtime-stop"),
      }) as never,
    recoverStartup: async () => ({ ok: true, value: lifecycle(order) as never }),
    recoverContextStartup: async () => undefined,
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
    options: {},
    location: { project: { canonical: "/ignored" }, directory: "/ignored" },
  } as never;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production composition resources", () => {
  test("opens the real store and initializes the unavailable exporter when export is unconfigured", async () => {
    const root = rootFixture();
    const order: string[] = [];
    const options = parseCommunicatorOptions(
      { stateDirectory: join(root, "state") },
      { HOME: root },
    );
    const plugin = createCompositionFactory(injectedDependencies(options, order));

    const hooks = await plugin(pluginInput());
    expect(readdirSync(options.stateDirectory)).toContain(`${workspaceKey.slice(0, 56)}.sqlite3`);
    await hooks.dispose?.();
    expect(order).toEqual(["lifecycle-stop", "scheduler-drain"]);
  });

  test("initializes and disposes the real configured exporter with every public limit", async () => {
    const root = rootFixture();
    const exportRoot = join(root, "exports");
    const order: string[] = [];
    const options = parseCommunicatorOptions(
      {
        stateDirectory: join(root, "state"),
        export: {
          root: exportRoot,
          limits: {
            maximumOutputBytes: 4_096,
            maximumConcurrent: 1,
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
    const hooks = await createCompositionFactory(dependencies)(pluginInput());

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
          root: "/proc/communicator-exports",
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
      const hooks = await createCompositionFactory(dependencies)(pluginInput());
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(21);
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
