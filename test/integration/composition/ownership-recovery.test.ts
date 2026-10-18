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
import { createCompositionFactory } from "../../../src/composition/plugin";
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

function nativeFixture(onQueue: () => void, onObserve: () => void = () => undefined) {
  return {
    readCurrentRoots: async () => {
      onObserve();
      return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
    },
    readVisibleRoots: async () => {
      onObserve();
      return [];
    },
    readParticipantPresence: async () => {
      onObserve();
      return "present" as const;
    },
    revalidateRoot: async () => {
      onObserve();
      return undefined;
    },
    observeRequestParticipants: async () => {
      onObserve();
      return { sourceVisible: true, targetVisible: true, targetStatus: "busy" as const };
    },
    observeParticipantActivities: async () => {
      onObserve();
      return [];
    },
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
    checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
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

function contractFaultLifecycle(token: number) {
  return {
    fencingToken: token,
    status: "stopped",
    stopState: {
      cause: "contract_fault",
      reason: "shutdown",
      recoverable: false,
      diagnostic: "A communicator port contract failed.",
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
  cause: "ownership_lost" | "contract_fault" = "ownership_lost",
): CommunicatorGenerationHandle {
  const invocations = new ActiveInvocationRegistry();
  return {
    lifecycle:
      status === "ready"
        ? readyLifecycle(token)
        : cause === "contract_fault"
          ? contractFaultLifecycle(token)
          : stoppedLifecycle(token),
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
    shutdownUnpublished: () => invocations.closeAdmission("unpublished_shutdown"),
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
  let announce!: (delayMs: number) => void;
  const started = new Promise<number>((resolve) => {
    announce = resolve;
  });
  return {
    port: {
      nowMs: clock.wall,
      wait(delayMs: number, abort: AbortSignal) {
        requestedMs = delayMs;
        announce(delayMs);
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
    started: () => started,
    elapse: () => complete?.(),
  };
}

function controlledSchedulerTimers() {
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();
  return {
    port: {
      set(_delayMs: number, callback: () => void) {
        const handle = ++nextHandle;
        callbacks.set(handle, callback);
        return handle;
      },
      clear(handle: unknown) {
        callbacks.delete(handle as number);
      },
    },
    fireArmed() {
      const armed = [...callbacks.values()];
      callbacks.clear();
      for (const callback of armed) callback();
    },
  };
}

async function bounded<Value>(promise: Promise<Value>, diagnostic: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(diagnostic)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function awaitDelayRequest(
  delay: ReturnType<typeof controlledDelay>,
  invocation: Promise<string>,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      delay.started(),
      invocation.then(
        () => Promise.reject(new Error("Invocation completed before recovery delay admission.")),
        (cause: unknown) => Promise.reject(cause),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Recovery delay barrier was not reached.")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("real SQLite composition ownership recovery", () => {
  test("production scheduler expiry recovers through the public managed tool bridge once", async () => {
    const path = stateDirectory();
    const clock = controlledClock();
    const schedulerTimers = controlledSchedulerTimers();
    const recoveryDelay = controlledDelay(clock);
    let nativeSubmissions = 0;
    let nativeObservations = 0;
    const native = nativeFixture(
      () => {
        nativeSubmissions += 1;
      },
      () => {
        nativeObservations += 1;
      },
    );
    const stores: LinuxBunSqliteStore[] = [];
    const lifecycles: Array<{
      observeStop(observer: (state: { cause: string }) => void): () => void;
    }> = [];
    const dependencies = generationDependencies(path, clock, native, stores);
    const binding = {
      workspaceKey: workspace,
      projectId: "project",
      directory: "/",
      worktree: "/",
    };
    const plugin = createCompositionFactory({
      ...dependencies,
      deriveWorkspace: () => binding,
      generationSchedulerTimers: schedulerTimers.port,
      generationRecoveryDelay: recoveryDelay.port,
      recoverStartup: async (...arguments_) => {
        const result = await recoverCommunicatorStartup(...arguments_);
        if (result.ok) lifecycles.push(result.value);
        return result;
      },
    });
    const hooks = await plugin({
      options: { stateDirectory: path, startupDeadlineMs: 5_000 },
      location: { project: { canonical: "/" }, directory: "/" },
    } as never);
    const initialStore = stores[0];
    const sessionList = hooks.tool?.session_list;
    if (!initialStore || !sessionList)
      throw new Error("Managed composition fixture was not built.");
    const initialToken = 1 as Awaited<ReturnType<LinuxBunSqliteStore["acquire"]>>;
    expect(await initialStore.isCurrent(initialToken)).toBeTrue();
    const startupObservations = nativeObservations;
    await sessionList.execute(
      {},
      {
        sessionID: source,
        messageID: "baseline",
        directory: "/",
        worktree: "/",
        abort: new AbortController().signal,
        ask: async () => undefined,
      },
    );
    const callbackObservations = nativeObservations - startupObservations;
    expect(callbackObservations).toBeGreaterThan(0);
    await initialStore.createPrepared(delivery(initialToken));
    await initialStore.claimPrepared({
      fencingToken: initialToken,
      workspaceKey: workspace,
      deliveryId,
      nowMs: clock.wall(),
    });

    const schedulerStopped = new Promise<string>((resolve) => {
      lifecycles[0]?.observeStop((state) => resolve(state.cause));
    });
    clock.advance(1_001);
    schedulerTimers.fireArmed();
    expect(await bounded(schedulerStopped, "Scheduler expiry did not stop ownership.")).toBe(
      "ownership_lost",
    );
    const observationsBeforeRecovery = nativeObservations;

    const invocation = Promise.resolve(
      sessionList.execute(
        {},
        {
          sessionID: source,
          messageID: "message",
          directory: "/",
          worktree: "/",
          abort: new AbortController().signal,
          ask: async () => undefined,
        },
      ),
    ).then(String);
    expect(await awaitDelayRequest(recoveryDelay, invocation)).toBe(99);
    recoveryDelay.elapse();
    expect(
      JSON.parse(await bounded(invocation, "Managed recovery invocation did not settle.")),
    ).toEqual({
      ok: true,
      value: [],
    });
    expect(stores).toHaveLength(2);
    const successorStore = stores[1];
    const successorToken = 2 as Awaited<ReturnType<LinuxBunSqliteStore["acquire"]>>;
    expect(await successorStore?.isCurrent(successorToken)).toBeTrue();
    expect(Number(successorToken)).toBeGreaterThan(Number(initialToken));
    expect(nativeObservations - observationsBeforeRecovery).toBe(
      startupObservations + callbackObservations,
    );
    expect(nativeSubmissions).toBe(0);
    const persisted = await successorStore?.getForParticipant({
      workspaceKey: workspace,
      deliveryId,
      participantSessionId: source,
    });
    expect(persisted?.delivery.state).toBe("admission_unknown");
    await hooks.dispose?.();
  });
});

describe("real SQLite manager ownership recovery", () => {
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
    expect(await awaitDelayRequest(delay, waitingInvocation)).toBe(99);
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

  test("recovers a contract-fault stop when the expired lease is free to retake", async () => {
    const path = stateDirectory();
    const clock = controlledClock();
    const staleStore = openStore(path, clock);
    const staleToken = await staleStore.acquire();
    clock.advance(1_101);
    expect(await staleStore.isCurrent(staleToken)).toBeFalse();
    expect(await staleStore.ownershipTakeoverDelayMs()).toBe(0);

    const stores: LinuxBunSqliteStore[] = [];
    const native = nativeFixture(() => undefined);
    const dependencies = generationDependencies(path, clock, native, stores);
    const options = parseCommunicatorOptions(
      { stateDirectory: path, startupDeadlineMs: 5_000 },
      { HOME: "/home/operator" },
    );
    const manager = new CommunicatorGenerationManager(
      generation(staleStore, Number(staleToken), "stopped", "contract_fault"),
      async (deadlineMs, abort) =>
        createCommunicatorGeneration({
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
        }),
      { nowMs: clock.wall, wait: async () => "completed" },
      5_000,
    );

    const waitingInvocation = invoke(manager);
    expect(JSON.parse(await waitingInvocation)).toEqual({ ok: true, value: [] });
    expect(Number(manager.current.fencingToken)).toBe(Number(staleToken) + 1);
    expect(manager.terminalState).toBeUndefined();
    const successorStore = stores[0];
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
    await awaitDelayRequest(delay, waitingInvocation);
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
