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
