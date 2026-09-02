import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ContextAdmissionRuntime } from "../../../src/application/context-admission-runtime";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { ActiveInvocationRegistry } from "../../../src/composition/active-invocations";
import { createChatMessagesTransformBookkeeping } from "../../../src/composition/chat-messages-transform";
import { createCommunicatorGeneration } from "../../../src/composition/communicator-generation";
import {
  type CommunicatorGenerationHandle,
  CommunicatorGenerationManager,
} from "../../../src/composition/communicator-generation-manager";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import { domainFailure } from "../../../src/domain/results";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

const workspaceKey = validateWorkspaceKey("generation-abort");
if (!workspaceKey.ok) throw new Error("Invalid workspace fixture.");

const generationBoundaryCases = [
  ["context", "Communicator ownership could not be established safely."],
  ["advisory", "Communicator ownership could not be established safely."],
  ["publication", "Communicator ownership could not be established safely."],
  ["lifecycle_stop", "A communicator workflow faulted."],
] as const;

function staleGeneration(): CommunicatorGenerationHandle {
  const invocations = new ActiveInvocationRegistry();
  return {
    lifecycle: {
      fencingToken: 1,
      status: "stopped",
      stopState: {
        cause: "ownership_lost",
        reason: "ownership_lost",
        recoverable: true,
        diagnostic: "Communicator ownership ended.",
      },
    } as never,
    invocations,
    fencingToken: 1 as never,
    contracts: {
      session_list: { description: "fixture", args: z.object({}), execute: async () => "stale" },
    } as never,
    event: async () => undefined,
    chat: async () => undefined,
    quiesce: () => invocations.closeAdmission(),
    drainInvocations: () => invocations.drain(),
    settleInvocations: () => invocations.settled(),
    ownershipTakeoverDelayMs: () => 0,
    shutdownUnpublished: () => invocations.closeAdmission(),
    disposeResources: async () => undefined,
  };
}

describe("generation startup cancellation", () => {
  test("disposal aborts successor startup and rolls its partial resources back once", async () => {
    const startupReached = barrier();
    let abortObserved = 0;
    let acquisitions = 0;
    let storesClosed = 0;
    let contextRecovery = 0;
    let nativeEffects = 0;
    const options = parseCommunicatorOptions({}, { HOME: "/home/operator" });
    const dependencies = {
      createContextRuntime: () => new ContextAdmissionRuntime(),
      createRuntime: (context?: ContextAdmissionRuntime) =>
        new RequestRuntime(undefined, undefined, undefined, context),
      createStore: () =>
        ({
          starts: {},
          acquire: async () => {
            acquisitions += 1;
            return 2 as never;
          },
          close: () => {
            storesClosed += 1;
          },
        }) as never,
      recoverStartup: async (
        ports: { ownership: { acquire(): Promise<unknown> } },
        input: { abort: AbortSignal },
      ) => {
        await ports.ownership.acquire();
        startupReached.release();
        await new Promise<void>((resolve) => {
          input.abort.addEventListener(
            "abort",
            () => {
              abortObserved += 1;
              resolve();
            },
            { once: true },
          );
        });
        return domainFailure("ownership_lost", "unsafe ignored detail", false);
      },
      recoverContextStartup: async () => {
        contextRecovery += 1;
      },
      generationClock: { nowMs: () => 1_000 },
      generationMonotonicNowMs: () => 1_000,
      generationSchedulerTimers: { set: () => 1, clear: () => undefined },
      generationStartupTimers: { set: () => 1, clear: () => undefined },
    } as never;
    const manager = new CommunicatorGenerationManager(
      staleGeneration(),
      (deadlineMs, abort) =>
        createCommunicatorGeneration({
          pluginInput: {} as never,
          options,
          workspace: {
            workspaceKey: workspaceKey.value,
            projectId: "project",
            directory: "/",
            worktree: "/",
          },
          native: {
            queueMessage: async () => {
              nativeEffects += 1;
              return { kind: "unknown" };
            },
          } as never,
          dependencies,
          chatBookkeeping: createChatMessagesTransformBookkeeping(),
          startupDeadlineMs: deadlineMs,
          startupAbort: abort,
        }),
      { nowMs: () => 1_000, wait: async () => "completed" },
      5_000,
    );
    const waiting = manager.invoke(
      "session_list",
      new AbortController().signal,
      (contract, context) => contract.execute({}, context),
      { sessionID: "session", messageID: "message", ask: async () => undefined },
    );
    await startupReached.reached;
    const disposal = manager.dispose();
    await expect(waiting).rejects.toThrow("host was disposed");
    await disposal;
    expect({ acquisitions, abortObserved, storesClosed, contextRecovery, nativeEffects }).toEqual({
      acquisitions: 1,
      abortObserved: 1,
      storesClosed: 1,
      contextRecovery: 0,
      nativeEffects: 0,
    });
    expect(manager.terminalState).toEqual({
      classification: "host_disposal",
      diagnostic: "The communicator host was disposed.",
    });
  });
});

describe("post-readiness generation cancellation", () => {
  test.each(["after_recovery", "context", "exporter", "advisory"] as const)(
    "stops construction at the %s boundary",
    async (race) => {
      const raceReached = barrier();
      let manager!: CommunicatorGenerationManager;
      let disposal: Promise<void> | undefined;
      let storesClosed = 0;
      let contextStarts = 0;
      let exporterStarts = 0;
      let advisoryStarts = 0;
      let checkpointStarts = 0;
      const options = parseCommunicatorOptions({}, { HOME: "/home/operator" });
      const lifecycle = {
        fencingToken: 2 as never,
        status: "ready",
        stopState: undefined,
        stopReason: undefined,
        effectSignal: new AbortController().signal,
        assertReady: () => undefined,
        observeStop: () => () => undefined,
        stop: () => undefined,
        scheduler: { wake: () => undefined, drain: async () => undefined },
      };
      const dependencies = {
        createContextRuntime: () => new ContextAdmissionRuntime(),
        createRuntime: (context?: ContextAdmissionRuntime) =>
          new RequestRuntime(undefined, undefined, undefined, context),
        createStore: () =>
          ({
            starts: {},
            close: () => {
              storesClosed += 1;
            },
          }) as never,
        recoverStartup: async () => {
          if (race === "after_recovery") {
            queueMicrotask(() => {
              raceReached.release();
              disposal = manager.dispose();
            });
          }
          return { ok: true, value: lifecycle as never } as const;
        },
        recoverContextStartup: async (
          _store: unknown,
          _lifecycle: unknown,
          _workspace: unknown,
          abort: AbortSignal,
        ) => {
          contextStarts += 1;
          if (race !== "context") return;
          raceReached.release();
          await new Promise<void>((resolve) => {
            if (abort.aborted) return resolve();
            abort.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        generationStartupCheckpoint: async (phase: string, abort: AbortSignal) => {
          checkpointStarts += 1;
          if ((race !== "exporter" && race !== "advisory") || phase !== race) return;
          raceReached.release();
          await new Promise<void>((resolve) => {
            if (abort.aborted) return resolve();
            abort.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        generationClock: { nowMs: () => 1_000 },
        generationMonotonicNowMs: () => 1_000,
        generationSchedulerTimers: { set: () => 1, clear: () => undefined },
        generationStartupTimers: { set: () => 1, clear: () => undefined },
        createExporter: () => {
          exporterStarts += 1;
          return { adapter: {} };
        },
        createAdvisoryLockHooks: () => {
          advisoryStarts += 1;
          return { wake: {} };
        },
      } as never;
      manager = new CommunicatorGenerationManager(
        staleGeneration(),
        (deadlineMs, abort) =>
          createCommunicatorGeneration({
            pluginInput: {} as never,
            options,
            workspace: {
              workspaceKey: workspaceKey.value,
              projectId: "project",
              directory: "/",
              worktree: "/",
            },
            native: {} as never,
            dependencies,
            chatBookkeeping: createChatMessagesTransformBookkeeping(),
            startupDeadlineMs: deadlineMs,
            startupAbort: abort,
          }),
        { nowMs: () => 1_000, wait: async () => "completed" },
        5_000,
      );
      const waiting = manager.invoke(
        "session_list",
        new AbortController().signal,
        (contract, context) => contract.execute({}, context),
        { sessionID: "session", messageID: "message", ask: async () => undefined },
      );
      await raceReached.reached;
      disposal ??= manager.dispose();
      await expect(waiting).rejects.toThrow("host was disposed");
      await disposal;
      expect(storesClosed).toBe(1);
      expect(exporterStarts).toBe(race === "advisory" ? 1 : 0);
      expect(advisoryStarts).toBe(0);
      expect(manager.terminalState?.classification).toBe("host_disposal");
      if (race === "after_recovery") expect(contextStarts).toBe(0);
      if (race === "context") expect(checkpointStarts).toBe(0);
    },
  );
});

describe("generation deadline boundaries", () => {
  test.each(generationBoundaryCases)(
    "fails closed after synchronous %s work",
    async (phase, expectedDiagnostic) => {
      let nowMs = 1_000;
      let storesClosed = 0;
      const cleanupOrder: string[] = [];
      const lifecycle = {
        fencingToken: 2 as never,
        status: "ready" as const,
        stopState: undefined,
        stopReason: undefined,
        effectSignal: new AbortController().signal,
        assertReady: () => undefined,
        observeStop: (observer: (state: never) => void) => {
          if (phase === "publication") nowMs = 2_000;
          if (phase === "lifecycle_stop") {
            const stopState = {
              cause: "workflow_fault",
              reason: "shutdown",
              recoverable: false,
              diagnostic: expectedDiagnostic,
            } as never;
            (lifecycle as { status: string; stopState?: unknown }).status = "stopped";
            (lifecycle as { stopState?: unknown }).stopState = stopState;
            observer(stopState);
          }
          return () => undefined;
        },
        stop: () => {
          cleanupOrder.push("lifecycle-stop", "scheduler-stop", "runtime-stop");
        },
        scheduler: {
          wake: () => undefined,
          drain: async () => {
            cleanupOrder.push("scheduler-drain");
          },
        },
      };
      const options = parseCommunicatorOptions({}, { HOME: "/home/operator" });
      const dependencies = {
        createContextRuntime: () => new ContextAdmissionRuntime(),
        createRuntime: (context?: ContextAdmissionRuntime) =>
          new RequestRuntime(undefined, undefined, undefined, context),
        createStore: () =>
          ({
            starts: {},
            close: () => {
              storesClosed += 1;
              cleanupOrder.push("store-close");
            },
          }) as never,
        recoverStartup: async () => ({ ok: true, value: lifecycle as never }) as const,
        recoverContextStartup: async () => {
          if (phase === "context") nowMs = 2_000;
        },
        generationStartupCheckpoint: async () => undefined,
        generationClock: { nowMs: () => nowMs },
        generationMonotonicNowMs: () => nowMs,
        generationSchedulerTimers: { set: () => 1, clear: () => undefined },
        generationStartupTimers: { set: () => 1, clear: () => undefined },
        createExporter: () => ({ adapter: {} }),
        createAdvisoryLockHooks: () => {
          if (phase === "advisory") nowMs = 2_000;
          return { wake: {} };
        },
      } as never;

      await expect(
        createCommunicatorGeneration({
          pluginInput: {} as never,
          options,
          workspace: {
            workspaceKey: workspaceKey.value,
            projectId: "project",
            directory: "/",
            worktree: "/",
          },
          native: { isEligibleContextTarget: async () => true } as never,
          dependencies,
          chatBookkeeping: createChatMessagesTransformBookkeeping(),
          startupDeadlineMs: 2_000,
          startupAbort: new AbortController().signal,
        }),
      ).rejects.toThrow(expectedDiagnostic);
      expect(storesClosed).toBe(1);
      expect(cleanupOrder.indexOf("scheduler-stop")).toBeLessThan(
        cleanupOrder.indexOf("store-close"),
      );
      expect(cleanupOrder.indexOf("runtime-stop")).toBeLessThan(
        cleanupOrder.indexOf("store-close"),
      );
      expect(cleanupOrder.indexOf("scheduler-drain")).toBeLessThan(
        cleanupOrder.indexOf("store-close"),
      );
    },
  );
});

describe("active generation construction deadline", () => {
  test("rejects an invalid linked startup control before constructing resources", async () => {
    let resourceFactories = 0;
    const dependencies = {
      generationClock: { nowMs: () => 1_000 },
      generationStartupTimers: {
        set: () => {
          throw new Error("timer detail");
        },
        clear: () => undefined,
      },
      createContextRuntime: () => {
        resourceFactories += 1;
        return new ContextAdmissionRuntime();
      },
    } as never;

    await expect(
      createCommunicatorGeneration({
        pluginInput: {} as never,
        options: parseCommunicatorOptions({}, { HOME: "/home/operator" }),
        workspace: {
          workspaceKey: workspaceKey.value,
          projectId: "project",
          directory: "/",
          worktree: "/",
        },
        native: {} as never,
        dependencies,
        chatBookkeeping: createChatMessagesTransformBookkeeping(),
        startupDeadlineMs: 2_000,
        startupAbort: new AbortController().signal,
      }),
    ).rejects.toThrow("port contract failed");
    expect(resourceFactories).toBe(0);
  });

  test("sanitizes a rejected factory phase and rolls partial resources back once", async () => {
    let storesClosed = 0;
    const lifecycle = {
      fencingToken: 1 as never,
      status: "ready" as const,
      stopState: undefined,
      effectSignal: new AbortController().signal,
      stop: () => undefined,
      scheduler: { drain: async () => undefined },
    };
    const dependencies = {
      createContextRuntime: () => new ContextAdmissionRuntime(),
      createRuntime: () =>
        ({ effectSignal: new AbortController().signal, stop: () => undefined }) as never,
      createStore: () =>
        ({
          starts: {},
          close: () => {
            storesClosed += 1;
          },
        }) as never,
      recoverStartup: async () => ({ ok: true, value: lifecycle as never }) as const,
      recoverContextStartup: async () => {
        throw new Error("secret rejected context phase");
      },
      generationClock: { nowMs: () => 1_000 },
      generationMonotonicNowMs: () => 1_000,
      generationSchedulerTimers: { set: () => 1, clear: () => undefined },
      generationStartupTimers: { set: () => 1, clear: () => undefined },
    } as never;

    await expect(
      createCommunicatorGeneration({
        pluginInput: {} as never,
        options: parseCommunicatorOptions({}, { HOME: "/home/operator" }),
        workspace: {
          workspaceKey: workspaceKey.value,
          projectId: "project",
          directory: "/",
          worktree: "/",
        },
        native: {} as never,
        dependencies,
        chatBookkeeping: createChatMessagesTransformBookkeeping(),
        startupDeadlineMs: 2_000,
        startupAbort: new AbortController().signal,
      }),
    ).rejects.toThrow("generation recovery failed");
    expect(storesClosed).toBe(1);
  });
});

describe("active generation construction interruption", () => {
  test.each(["context", "checkpoint"] as const)(
    "interrupts a noncooperative %s phase and rolls back once",
    async (phase) => {
      let nowMs = 1_000;
      let nextTimer = 0;
      let rejectLate!: (cause: unknown) => void;
      let reachPhase!: () => void;
      const phaseReached = new Promise<void>((resolve) => {
        reachPhase = resolve;
      });
      const never = new Promise<void>((_resolve, reject) => {
        rejectLate = reject;
      });
      const callbacks = new Map<number, () => void>();
      const order: string[] = [];
      const storeClosed = barrier();
      const lifecycle = {
        fencingToken: 1 as never,
        status: "ready" as const,
        stopState: undefined,
        stopReason: undefined,
        effectSignal: new AbortController().signal,
        assertReady: () => undefined,
        observeStop: () => () => undefined,
        stop: () => {
          order.push("lifecycle-stop", "scheduler-stop", "runtime-stop");
        },
        scheduler: { wake: () => undefined, drain: async () => order.push("scheduler-drain") },
      };
      const dependencies = {
        createContextRuntime: () => new ContextAdmissionRuntime(),
        createRuntime: () =>
          ({
            effectSignal: new AbortController().signal,
            stop: () => order.push("runtime-stop"),
          }) as never,
        createStore: () =>
          ({
            starts: {},
            close: () => {
              order.push("store-close");
              storeClosed.release();
            },
          }) as never,
        recoverStartup: async () => ({ ok: true, value: lifecycle as never }) as const,
        recoverContextStartup: async () => {
          if (phase !== "context") return;
          reachPhase();
          return never;
        },
        generationStartupCheckpoint: async (name: string) => {
          if (phase !== "checkpoint" || name !== "participants") return;
          reachPhase();
          return never;
        },
        generationClock: { nowMs: () => nowMs },
        generationMonotonicNowMs: () => nowMs,
        generationSchedulerTimers: { set: () => 1, clear: () => undefined },
        generationStartupTimers: {
          set: (_delay: number, callback: () => void) => {
            const handle = ++nextTimer;
            callbacks.set(handle, callback);
            return handle;
          },
          clear: (handle: unknown) => callbacks.delete(handle as number),
        },
      } as never;
      const pending = createCommunicatorGeneration({
        pluginInput: {} as never,
        options: parseCommunicatorOptions({}, { HOME: "/home/operator" }),
        workspace: {
          workspaceKey: workspaceKey.value,
          projectId: "project",
          directory: "/",
          worktree: "/",
        },
        native: {} as never,
        dependencies,
        chatBookkeeping: createChatMessagesTransformBookkeeping(),
        startupDeadlineMs: 2_000,
        startupAbort: new AbortController().signal,
      });

      await phaseReached;
      nowMs = 2_000;
      for (const callback of [...callbacks.values()]) callback();
      await expect(pending).rejects.toThrow("ownership could not be established safely");
      expect(order).not.toContain("store-close");
      expect(order).toContain("scheduler-stop");
      expect(order).toContain("runtime-stop");
      rejectLate(new Error("late noncooperative rejection"));
      await storeClosed.reached;
      expect(order.filter((entry) => entry === "store-close")).toHaveLength(1);
      expect(order.indexOf("scheduler-drain")).toBeLessThan(order.indexOf("store-close"));
    },
  );
});

describe("managed invocation cancellation", () => {
  test("cancels without a callback when the caller stops while recovery is pending", async () => {
    const buildStarted = barrier();
    const releaseBuild = barrier();
    const successor = staleGeneration();
    (successor.lifecycle as { status: string; stopState?: unknown; fencingToken: number }).status =
      "ready";
    (successor.lifecycle as { stopState?: unknown }).stopState = undefined;
    (successor as { fencingToken: number }).fencingToken = 2;
    let callbacks = 0;
    let builds = 0;
    const manager = new CommunicatorGenerationManager(
      staleGeneration(),
      async () => {
        builds += 1;
        buildStarted.release();
        await releaseBuild.reached;
        return successor;
      },
      { nowMs: () => 1_000, wait: async () => "completed" },
      1_000,
    );
    const caller = new AbortController();
    const invocation = manager.invoke(
      "session_list",
      caller.signal,
      async () => {
        callbacks += 1;
        return "unexpected";
      },
      { sessionID: "session", messageID: "message", ask: async () => undefined },
    );
    await buildStarted.reached;
    caller.abort("caller_cancelled");
    releaseBuild.release();

    await expect(invocation).rejects.toThrow("invocation was cancelled");
    expect({ callbacks, builds, state: manager.state }).toEqual({
      callbacks: 0,
      builds: 1,
      state: "active",
    });
    await manager.dispose();
  });

  test("cancels in the admission microtask before callback or parsing begins", async () => {
    const ready = staleGeneration();
    (ready.lifecycle as { status: string; stopState?: unknown }).status = "ready";
    (ready.lifecycle as { stopState?: unknown }).stopState = undefined;
    let callbacks = 0;
    let builds = 0;
    const manager = new CommunicatorGenerationManager(
      ready,
      async () => {
        builds += 1;
        return staleGeneration();
      },
      { nowMs: () => 1_000, wait: async () => "completed" },
      1_000,
    );
    const caller = new AbortController();
    const invocation = manager.invoke(
      "session_list",
      caller.signal,
      async () => {
        callbacks += 1;
        return "unexpected";
      },
      { sessionID: "session", messageID: "message", ask: async () => undefined },
    );
    queueMicrotask(() => caller.abort("caller_cancelled"));

    await expect(invocation).rejects.toThrow("invocation was cancelled");
    expect({ callbacks, builds, state: manager.state }).toEqual({
      callbacks: 0,
      builds: 0,
      state: "active",
    });
    await manager.dispose();
  });
});
