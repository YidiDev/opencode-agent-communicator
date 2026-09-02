import { describe, expect, test } from "bun:test";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import { createCompositionFactory } from "../../../src/composition/plugin";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("recovery-workspace");
if (!workspace.ok) throw new Error("Invalid workspace fixture.");

class LifecycleFixture {
  readonly effectSignal = new AbortController().signal;
  readonly scheduler = { wake: () => undefined, drain: async () => undefined };
  status: "ready" | "stopped" = "ready";
  stopState:
    | {
        cause: "ownership_lost";
        reason: "ownership_lost";
        recoverable: true;
        diagnostic: string;
      }
    | undefined;
  private readonly observers = new Set<(state: NonNullable<this["stopState"]>) => void>();

  constructor(readonly fencingToken: number) {}

  assertReady(): void {
    if (this.status !== "ready") throw new Error("not ready");
  }

  observeStop(observer: (state: NonNullable<this["stopState"]>) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  stop(reason: "shutdown" | "ownership_lost"): void {
    if (this.status === "stopped") return;
    this.status = "stopped";
    if (reason !== "ownership_lost") return;
    this.stopState = {
      cause: "ownership_lost",
      reason: "ownership_lost",
      recoverable: true,
      diagnostic: "Communicator ownership ended.",
    };
    for (const observer of this.observers) observer(this.stopState);
  }
}

function toolContext() {
  return {
    sessionID: "ses_0123456789abcdef0123456789abcdef",
    messageID: "msg",
    agent: "build",
    directory: "/",
    worktree: "/",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

describe("plugin ownership recovery", () => {
  test("recovers before schema parsing and a later invocation succeeds without restart", async () => {
    const lifecycles: LifecycleFixture[] = [];
    let stores = 0;
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
          readCurrentRoots: async () => ({
            sourceVisible: true,
            targetVisible: true,
            sourceTitle: "Source",
          }),
          readVisibleRoots: async () => [],
          readParticipantPresence: async () => "present",
          isEligibleContextTarget: async () => true,
        }) as never,
      createStore: () => {
        stores += 1;
        return {
          starts: {},
          ownershipTakeoverDelayMs: () => 0,
          close: () => undefined,
        } as never;
      },
      createRuntime: () =>
        ({ effectSignal: new AbortController().signal, stop: () => undefined }) as never,
      recoverStartup: async () => {
        const lifecycle = new LifecycleFixture(lifecycles.length + 1);
        lifecycles.push(lifecycle);
        return { ok: true, value: lifecycle as never };
      },
      recoverContextStartup: async () => undefined,
      createExporter: () => ({
        adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
      }),
    });
    const hooks = await Reflect.apply(plugin, undefined, [{}, {}]);
    const sessionList = hooks.tool?.session_list;
    if (!sessionList) throw new Error("session_list was not registered");

    lifecycles[0]?.stop("ownership_lost");
    const invalid = JSON.parse(
      String(await sessionList.execute({ invalid_before_recovery: true }, toolContext())),
    );
    expect(invalid.error.code).toBe("invalid_arguments");
    expect(lifecycles).toHaveLength(2);
    expect(stores).toBe(2);
    const result = JSON.parse(String(await sessionList.execute({}, toolContext())));
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([]);
    expect(lifecycles[1]?.fencingToken).toBeGreaterThan(lifecycles[0]?.fencingToken ?? 0);
    await hooks["experimental.chat.messages.transform"]?.(
      {} as never,
      { messages: undefined } as never,
    );
    await hooks.dispose?.();
  });

  test("rolls back generation resources when post-export construction fails", async () => {
    const order: string[] = [];
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
      createStore: () => ({ starts: {}, close: () => order.push("store-close") }) as never,
      recoverStartup: async () => ({
        ok: true,
        value: {
          fencingToken: 1 as never,
          effectSignal: new AbortController().signal,
          observeStop: () => () => undefined,
          stop: () => order.push("lifecycle-stop"),
          scheduler: { drain: async () => order.push("scheduler-drain") },
        } as never,
      }),
      recoverContextStartup: async () => undefined,
      createExporter: () => ({
        adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
        drain: async () => {
          order.push("exporter-drain");
        },
        dispose: () => order.push("exporter-dispose"),
      }),
      createAdvisoryLockHooks: () => {
        throw new Error("advisory construction failed");
      },
    });

    await expect(Reflect.apply(plugin, undefined, [{}, {}])).rejects.toThrow(
      "generation recovery failed",
    );
    expect(order).toEqual([
      "lifecycle-stop",
      "scheduler-drain",
      "exporter-drain",
      "exporter-dispose",
      "store-close",
    ]);
  });

  test("disposes an initial generation stopped after construction instead of exposing hooks", async () => {
    const lifecycle = new LifecycleFixture(1);
    let storesClosed = 0;
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
      createStore: () =>
        ({
          starts: {},
          close: () => {
            storesClosed += 1;
          },
        }) as never,
      createRuntime: () =>
        ({ effectSignal: new AbortController().signal, stop: () => undefined }) as never,
      recoverStartup: async () => ({ ok: true, value: lifecycle as never }),
      recoverContextStartup: async () => undefined,
      createExporter: () => ({
        adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
      }),
      createAdvisoryLockHooks: () => {
        queueMicrotask(() => lifecycle.stop("ownership_lost"));
        return { wake: {} as never };
      },
    });

    await expect(Reflect.apply(plugin, undefined, [{}, {}])).rejects.toThrow(
      "Communicator ownership ended.",
    );
    expect(storesClosed).toBe(1);
  });
});
