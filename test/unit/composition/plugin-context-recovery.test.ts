import { describe, expect, test } from "bun:test";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import {
  createCompositionFactory,
  failUncertainContextOnStartup,
} from "../../../src/composition/plugin";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("context-recovery-coverage");
if (!workspace.ok) throw new Error("Invalid workspace fixture.");

describe("production context startup recovery wiring", () => {
  test("drains repeated bounded context batches before exposing hooks", async () => {
    const batchSizes = [100, 100, 0];
    let calls = 0;
    const store = {
      starts: {},
      failUncertainContextOnStartup: async () => {
        const size = batchSizes[calls] ?? 0;
        calls += 1;
        return Array.from({ length: size }, () => "context");
      },
      close: () => undefined,
    };
    const lifecycle = {
      fencingToken: 1 as never,
      status: "ready",
      stopState: undefined,
      stopReason: undefined,
      effectSignal: new AbortController().signal,
      assertReady: () => undefined,
      observeStop: () => () => undefined,
      stop: () => undefined,
      scheduler: { wake: () => undefined, drain: async () => undefined },
    };
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/",
        worktree: "/",
      }),
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "1.18.23" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "1.18.23" } }),
      createNative: () =>
        ({
          readParticipantPresence: async () => "present",
          isEligibleContextTarget: async () => true,
        }) as never,
      createStore: () => store as never,
      recoverStartup: async () => ({ ok: true, value: lifecycle as never }),
      createExporter: () => ({
        adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
      }),
    });

    const hooks = await Reflect.apply(plugin, undefined, [{}, {}]);
    expect(calls).toBe(3);
    await hooks.dispose?.();
  });

  test("checks cancellation before and after each awaited context batch", async () => {
    const prior = new AbortController();
    prior.abort("raw reason must not escape");
    let calls = 0;
    const store = {
      failUncertainContextOnStartup: async () => {
        calls += 1;
        return [];
      },
    } as never;
    await expect(
      failUncertainContextOnStartup(
        store,
        { fencingToken: 1 } as never,
        workspace.value,
        prior.signal,
      ),
    ).rejects.toThrow("startup was cancelled");
    expect(calls).toBe(0);

    const during = new AbortController();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = failUncertainContextOnStartup(
      {
        failUncertainContextOnStartup: async () => {
          during.abort("private path /workspace");
          release();
          return [];
        },
      } as never,
      { fencingToken: 1 } as never,
      workspace.value,
      during.signal,
    );
    await entered;
    await expect(pending).rejects.toThrow("startup was cancelled");
  });
});
