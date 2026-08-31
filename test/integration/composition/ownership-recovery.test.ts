import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LinuxBunSqliteStore } from "../../../src/adapters/store/sqlite-store";
import { ContextAdmissionRuntime } from "../../../src/application/context-admission-runtime";
import type { PrepareDeliveryInput } from "../../../src/application/delivery-ports";
import { recoverCommunicatorStartup } from "../../../src/application/recover-communicator-startup";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { ActiveInvocationRegistry } from "../../../src/composition/active-invocations";
import { createChatMessagesTransformBookkeeping } from "../../../src/composition/chat-messages-transform";
import { createCommunicatorGeneration } from "../../../src/composition/communicator-generation";
import {
  type CommunicatorGenerationHandle,
  CommunicatorGenerationManager,
} from "../../../src/composition/communicator-generation-manager";
import type { CompositionDependencies } from "../../../src/composition/composition-dependencies";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("Invalid integration fixture.");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("workspace-composition-recovery"));
const source = valid(validateSessionId("ses_source"));
const target = valid(validateSessionId("ses_target"));
const deliveryId = valid(validateDeliveryId("dlv_0123456789abcdef0123456789abcdef"));
const nativeMessageId = valid(validateNativeMessageId("msg_0123456789abcdef0123456789abcdef"));
const roots: string[] = [];
const databaseFileName = `${workspace.slice(0, 56)}.sqlite3`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controlledClock() {
  let wall = 100_000;
  let monotonic = 100_000;
  return {
    wall: () => wall,
    monotonic: () => monotonic,
    advance(milliseconds: number) {
      wall += milliseconds;
      monotonic += milliseconds;
    },
  };
}

function stateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "communicator-composition-recovery-"));
  roots.push(root);
  return join(root, "state");
}

function openStore(path: string, clock: ReturnType<typeof controlledClock>) {
  return new LinuxBunSqliteStore({
    stateDirectory: path,
    workspaceKey: workspace,
    databaseFileName,
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: clock.wall,
    nowMonotonicMs: clock.monotonic,
  });
}

function nativeFixture(onQueue: () => void) {
  return {
    readCurrentRoots: async () => ({
      sourceVisible: true,
      targetVisible: true,
      sourceTitle: "Source",
    }),
    readVisibleRoots: async () => [],
    readParticipantPresence: async () => "present" as const,
    observeRequestParticipants: async () => ({
      sourceVisible: true,
      targetVisible: true,
      targetStatus: "busy" as const,
    }),
    observeParticipantActivities: async () => [],
    queueMessage: async () => {
      onQueue();
      throw new Error("Submitting recovery must never replay native admission.");
    },
    steerRequest: async () => ({ kind: "unknown" as const }),
    reconcileRootSession: async () => "unknown" as const,
    readMessage: async () => ({ kind: "not_found" as const, rawResponseByteCount: 0 }),
    isEligibleContextTarget: async () => true,
  } as never;
}

function generationDependencies(
  path: string,
  clock: ReturnType<typeof controlledClock>,
  native: ReturnType<typeof nativeFixture>,
  stores: LinuxBunSqliteStore[],
): CompositionDependencies {
  const timers = { set: () => 1, clear: () => undefined };
  return {
    parseOptions: parseCommunicatorOptions,
    deriveWorkspace: () => {
      throw new Error("unused");
    },
    createHealth: () => ({ readHealth: async () => ({}) }),
    runtimeIdentity: { readIdentity: () => ({}) },
    createNative: () => native,
    checkCompatibility: async () => ({ ok: true, value: { version: "1.18.25" } }),
    createStore: (options) => {
      const store = new LinuxBunSqliteStore({
        ...options,
        stateDirectory: path,
        leaseDurationMs: 1_000,
        takeoverGraceMs: 100,
        nowWallMs: clock.wall,
        nowMonotonicMs: clock.monotonic,
      });
      stores.push(store);
      return store;
    },
    createContextRuntime: () => new ContextAdmissionRuntime(),
    createRuntime: (context) => new RequestRuntime(undefined, undefined, undefined, context),
    generationRecoveryDelay: { nowMs: clock.wall, wait: async () => "completed" },
    generationClock: { nowMs: clock.wall },
    generationSchedulerTimers: timers,
    generationStartupTimers: timers,
    generationMonotonicNowMs: clock.monotonic,
    generationStartupCheckpoint: async () => undefined,
    createAdvisoryLockHooks: ({ lifecycle }) => ({
      wake: { wakeAdvisoryLockExpiry: () => lifecycle.scheduler.wake() },
      notifications: {} as never,
    }),
    recoverStartup: recoverCommunicatorStartup,
    recoverContextStartup: async (store, lifecycle) => {
      await store.failUncertainContextOnStartup({
        fencingToken: lifecycle.fencingToken,
        workspaceKey: workspace,
        limit: 100,
      });
    },
    createExporter: () => ({
      adapter: { writeExport: async () => ({ ok: false as const, code: "export_unavailable" }) },
    }),
  };
}

function delivery(
  token: Awaited<ReturnType<LinuxBunSqliteStore["acquire"]>>,
): PrepareDeliveryInput {
  return {
    id: deliveryId,
    workspaceKey: workspace,
    fencingToken: token,
    sourceSessionId: source,
    targetSessionId: target,
    nativeMessageId,
    envelope: '{"payload":{"content":"never replay"}}',
    contentByteLength: 12,
    contentSha256: "a".repeat(64) as Sha256Digest,
    nowMs: 100_000,
  };
}

function stoppedLifecycle(token: number) {
  return {
    fencingToken: token,
    status: "stopped",
    stopState: {
      cause: "ownership_lost",
      reason: "ownership_lost",
      recoverable: true,
      diagnostic: "Communicator ownership ended.",
    },
  } as never;
}

function readyLifecycle(token: number) {
  return { fencingToken: token, status: "ready", stopState: undefined } as never;
}

function generation(
  store: LinuxBunSqliteStore,
  token: number,
  status: "ready" | "stopped",
): CommunicatorGenerationHandle {
  const invocations = new ActiveInvocationRegistry();
  return {
    lifecycle: status === "ready" ? readyLifecycle(token) : stoppedLifecycle(token),
    invocations,
    fencingToken: token as never,
    contracts: {
      session_list: {
        description: "real store recovery fixture",
        args: z.object({}).strict(),
        execute: async () => `epoch-${token}`,
      },
    } as never,
    event: async () => undefined,
    chat: async () => undefined,
    quiesce: () => invocations.closeAdmission("ownership_lost"),
    drainInvocations: () => invocations.drain(),
    settleInvocations: () => invocations.settled(),
    ownershipTakeoverDelayMs: () => store.ownershipTakeoverDelayMs(),
    disposeResources: async () => store.close(),
  };
}

function invoke(manager: CommunicatorGenerationManager): Promise<string> {
  return manager.invoke(
    "session_list",
    new AbortController().signal,
    (contract, context) => contract.execute({}, context),
    { sessionID: source, messageID: "message", ask: async () => undefined },
  );
}

function controlledDelay(clock: ReturnType<typeof controlledClock>) {
  let complete: (() => void) | undefined;
  let requestedMs: number | undefined;
  return {
    port: {
      nowMs: clock.wall,
      wait(delayMs: number, abort: AbortSignal) {
        requestedMs = delayMs;
        return new Promise<"completed" | "aborted">((resolve) => {
          complete = () => {
            if (abort.aborted) return resolve("aborted");
            clock.advance(delayMs);
            resolve("completed");
          };
        });
      },
    },
    requested: () => requestedMs,
    elapse: () => complete?.(),
  };
}

describe("real SQLite composition ownership recovery", () => {
  test("waits through grace, advances the epoch, and never replays a submitting delivery", async () => {
    const path = stateDirectory();
    const clock = controlledClock();
    const staleStore = openStore(path, clock);
    const staleToken = await staleStore.acquire();
    const prepared = delivery(staleToken);
    await staleStore.createPrepared(prepared);
    await staleStore.claimPrepared({
      fencingToken: staleToken,
      workspaceKey: workspace,
      deliveryId,
      nowMs: 100_001,
    });
    clock.advance(1_001);
    expect(await staleStore.isCurrent(staleToken)).toBeFalse();

    const delay = controlledDelay(clock);
    let nativeSubmissions = 0;
    const native = nativeFixture(() => {
      nativeSubmissions += 1;
    });
    const stores: LinuxBunSqliteStore[] = [];
    const dependencies = generationDependencies(path, clock, native, stores);
    const options = parseCommunicatorOptions(
      { stateDirectory: path, startupDeadlineMs: 5_000 },
      { HOME: "/home/operator" },
    );
    const manager = new CommunicatorGenerationManager(
      generation(staleStore, Number(staleToken), "stopped"),
      async (deadlineMs, abort) => {
        expect(deadlineMs).toBe(106_001);
        return createCommunicatorGeneration({
          pluginInput: {} as never,
          options,
          workspace: {
            workspaceKey: workspace,
            projectId: "project",
            directory: "/",
            worktree: "/",
          },
          native,
          dependencies,
          chatBookkeeping: createChatMessagesTransformBookkeeping(),
          startupDeadlineMs: deadlineMs,
          startupAbort: abort,
        });
      },
      delay.port,
      5_000,
    );

    const waitingInvocation = invoke(manager);
    while (delay.requested() === undefined) await Promise.resolve();
    expect(delay.requested()).toBe(99);
    delay.elapse();
    expect(JSON.parse(await waitingInvocation)).toEqual({ ok: true, value: [] });
    expect(Number(manager.current.fencingToken)).toBe(Number(staleToken) + 1);
    expect(nativeSubmissions).toBe(0);
    const successorStore = stores[0];
    const persisted = await successorStore?.getForParticipant({
      workspaceKey: workspace,
      deliveryId,
      participantSessionId: source,
    });
    expect(persisted?.delivery.state).toBe("admission_unknown");
    expect(await successorStore?.isCurrent(manager.current.fencingToken)).toBeTrue();
    await manager.dispose();
  });

  test("an active competing takeover blocks the single replacement attempt", async () => {
    const path = stateDirectory();
    const clock = controlledClock();
    const staleStore = openStore(path, clock);
    const staleToken = await staleStore.acquire();
    clock.advance(1_001);
    const delay = controlledDelay(clock);
    let builds = 0;
    const stores: LinuxBunSqliteStore[] = [];
    const native = nativeFixture(() => undefined);
    const dependencies = generationDependencies(path, clock, native, stores);
    const options = parseCommunicatorOptions(
      { stateDirectory: path, startupDeadlineMs: 5_000 },
      { HOME: "/home/operator" },
    );
    const manager = new CommunicatorGenerationManager(
      generation(staleStore, Number(staleToken), "stopped"),
      async (deadlineMs, abort) => {
        builds += 1;
        return createCommunicatorGeneration({
          pluginInput: {} as never,
          options,
          workspace: {
            workspaceKey: workspace,
            projectId: "project",
            directory: "/",
            worktree: "/",
          },
          native,
          dependencies,
          chatBookkeeping: createChatMessagesTransformBookkeeping(),
          startupDeadlineMs: deadlineMs,
          startupAbort: abort,
        });
      },
      delay.port,
      5_000,
    );
    const waitingInvocation = invoke(manager);
    while (delay.requested() === undefined) await Promise.resolve();
    delay.elapse();
    const competitor = openStore(path, clock);
    const competitorToken = await competitor.acquire();
    const diagnostic = "Communicator ownership is held by another backend.";
    await expect(waitingInvocation).rejects.toThrow(diagnostic);
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    expect(manager.terminalState).toEqual({
      classification: "ownership_unavailable",
      diagnostic,
    });
    expect(builds).toBe(1);
    expect(Number(competitorToken)).toBe(Number(staleToken) + 1);
    expect(await competitor.isCurrent(competitorToken)).toBeTrue();
    competitor.close();
  });
});
