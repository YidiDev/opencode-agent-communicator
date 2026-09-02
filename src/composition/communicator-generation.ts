import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { OpenCodeNativeAdapter } from "../adapters/native/opencode-1-18";
import type { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import {
  OwnershipUnavailableError,
  sqliteStoreDefaultTakeoverGraceMs,
} from "../adapters/store/store-types";
import { settleUntilAborted } from "../application/abortable-operation";
import type { CommunicatorStartupRecoveryLifecycle } from "../application/communicator-startup-lifecycle";
import type { ContextAdmissionRuntime } from "../application/context-admission-runtime";
import { ParticipantDeletionLifecycle } from "../application/participant-deletion-lifecycle";
import { ParticipantOperationGate } from "../application/participant-operation-gate";
import { ParticipantStopLifecycle } from "../application/participant-stop-lifecycle";
import type { RequestRuntime } from "../application/request-runtime";
import { createLinkedEffectControl } from "../application/startup-effect-control";
import { ActiveInvocationRegistry } from "./active-invocations";
import {
  type ChatMessagesTransformBookkeeping,
  createChatMessagesTransform,
} from "./chat-messages-transform";
import {
  assertGenerationStartupBoundary,
  CommunicatorGenerationConstructionError,
  constructionErrorForLifecycle,
  constructionErrorForStartupCode,
  sanitizeGenerationConstructionError,
} from "./communicator-generation-errors";
import {
  CommunicatorGeneration,
  type CommunicatorToolContracts,
} from "./communicator-generation-instance";
import {
  disposeUnpublishedGeneration,
  type PartialGenerationResources,
  quiescePartialGeneration,
  rollbackPartialGeneration,
} from "./communicator-generation-rollback";
import type { CompositionDependencies } from "./composition-dependencies";
import type { CommunicatorOptions } from "./config";
import { productionSha256 } from "./primitives";
import { configuredStartPolicy, constructToolContracts } from "./tools";
import { unavailableSessionExporter } from "./unavailable-exporter";
import type { WorkspaceBinding } from "./workspace";

type EventHook = NonNullable<Hooks["event"]>;

export { CommunicatorGeneration, type CommunicatorToolContracts };

export interface CommunicatorGenerationFactoryInput {
  readonly pluginInput: PluginInput;
  readonly options: CommunicatorOptions;
  readonly workspace: WorkspaceBinding;
  readonly native: OpenCodeNativeAdapter;
  readonly dependencies: CompositionDependencies;
  readonly chatBookkeeping: ChatMessagesTransformBookkeeping;
  readonly startupDeadlineMs: number;
  readonly startupAbort: AbortSignal;
}

async function cleanupFailedGeneration(
  generation: CommunicatorGeneration | undefined,
  resources: PartialGenerationResources,
): Promise<void> {
  if (!generation) return rollbackPartialGeneration(resources);
  await disposeUnpublishedGeneration(generation);
}

function startupOwnership(store: LinuxBunSqliteStore, contention: () => void) {
  return {
    acquire: async () => {
      try {
        return await store.acquire();
      } catch (cause: unknown) {
        if (cause instanceof OwnershipUnavailableError) contention();
        throw cause;
      }
    },
    isCurrent: (token: Parameters<LinuxBunSqliteStore["isCurrent"]>[0]) => store.isCurrent(token),
  };
}

function assertFactoryBoundary(input: CommunicatorGenerationFactoryInput): void {
  assertGenerationStartupBoundary(input.startupAbort, input.startupDeadlineMs, () =>
    input.dependencies.generationClock.nowMs(),
  );
}

function assertLinkedFactoryBoundary(
  input: CommunicatorGenerationFactoryInput,
  signal: AbortSignal,
): void {
  if (!signal.aborted) {
    assertGenerationStartupBoundary(signal, input.startupDeadlineMs, () =>
      input.dependencies.generationClock.nowMs(),
    );
    return;
  }
  assertFactoryBoundary(input);
  throw new CommunicatorGenerationConstructionError("contract_fault");
}

class InterruptedFactoryPhase {
  constructor(
    readonly cause: unknown,
    readonly settlement: Promise<void>,
  ) {}
}

async function runFactoryPhase<Value>(
  input: CommunicatorGenerationFactoryInput,
  signal: AbortSignal,
  operation: () => Promise<Value>,
): Promise<Value> {
  const promise = operation();
  const result = await settleUntilAborted(promise, signal);
  if (result.kind === "settled") return result.value;
  if (result.kind === "rejected") throw result.cause;
  let cause: unknown;
  try {
    assertLinkedFactoryBoundary(input, signal);
    cause = new CommunicatorGenerationConstructionError("contract_fault");
  } catch (interruption: unknown) {
    cause = interruption;
  }
  const settlement = Promise.prototype.then.call(
    promise,
    () => undefined,
    () => undefined,
  ) as Promise<void>;
  throw new InterruptedFactoryPhase(cause, settlement);
}

function createFactoryStartupControl(input: CommunicatorGenerationFactoryInput) {
  const control = createLinkedEffectControl({
    signals: [input.startupAbort],
    deadlineMs: input.startupDeadlineMs,
    clock: input.dependencies.generationClock,
    timers: input.dependencies.generationStartupTimers,
  });
  if (!control) throw new CommunicatorGenerationConstructionError("contract_fault");
  return control;
}

function disposeFactoryStartupControl(control: { dispose(): void }): void {
  try {
    control.dispose();
  } catch {
    throw new CommunicatorGenerationConstructionError("contract_fault");
  }
}

function recoverFactoryStartup(
  input: CommunicatorGenerationFactoryInput,
  signal: AbortSignal,
  store: LinuxBunSqliteStore,
  runtime: RequestRuntime,
  ownership: ReturnType<typeof startupOwnership>,
) {
  const { dependencies, native, options, workspace } = input;
  return runFactoryPhase(input, signal, () =>
    dependencies.recoverStartup(
      {
        membership: native,
        deliveries: store,
        nativeQueue: native,
        requests: store,
        locks: store,
        participantPresence: native,
        activity: native,
        nativeSteer: native,
        ownership,
        startupBarrier: store,
        clock: dependencies.generationClock,
        runtime,
        resultRetention: store,
        requestRetention: store,
        starts: store.starts,
        requestStarts: store,
        nativeStart: native,
        digest: productionSha256,
        startLimits: configuredStartPolicy(options).limits,
      },
      {
        workspaceKey: workspace.workspaceKey,
        abort: signal,
        deadlineMs: input.startupDeadlineMs,
        limit: 100,
        timers: dependencies.generationSchedulerTimers,
        startupTimers: dependencies.generationStartupTimers,
        nowMonotonicMs: dependencies.generationMonotonicNowMs,
      },
    ),
  );
}

export async function createCommunicatorGeneration(
  input: CommunicatorGenerationFactoryInput,
): Promise<CommunicatorGeneration> {
  const { dependencies, native, options, workspace } = input;
  const startupControl = createFactoryStartupControl(input);
  const startupSignal = startupControl.signal;
  const assertBoundary = (): void => assertLinkedFactoryBoundary(input, startupSignal);
  let contextRuntime: ContextAdmissionRuntime | undefined;
  let runtime: RequestRuntime | undefined;
  let store: LinuxBunSqliteStore | undefined;
  let lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  let participantOperations: ParticipantOperationGate | undefined;
  let deletion: ParticipantDeletionLifecycle | undefined;
  let participantStop: ParticipantStopLifecycle | undefined;
  let exporter: ReturnType<CompositionDependencies["createExporter"]> | undefined;
  let advisory: ReturnType<CompositionDependencies["createAdvisoryLockHooks"]> | undefined;
  let generation: CommunicatorGeneration | undefined;
  let confirmedOwnershipContention = false;
  try {
    assertBoundary();
    const createdContextRuntime = dependencies.createContextRuntime();
    contextRuntime = createdContextRuntime;
    assertBoundary();
    const createdRuntime = dependencies.createRuntime(createdContextRuntime);
    runtime = createdRuntime;
    assertBoundary();
    store = dependencies.createStore({
      stateDirectory: options.stateDirectory,
      databaseFileName: `${workspace.workspaceKey.slice(0, 56)}.sqlite3`,
      workspaceKey: workspace.workspaceKey,
      nowWallMs: () => dependencies.generationClock.nowMs(),
      nowMonotonicMs: dependencies.generationMonotonicNowMs,
      takeoverGraceMs: sqliteStoreDefaultTakeoverGraceMs,
    });
    assertBoundary();
    const ownedStore = store;
    const ownership = startupOwnership(ownedStore, () => {
      confirmedOwnershipContention = true;
    });
    const recovered = await recoverFactoryStartup(
      input,
      startupSignal,
      ownedStore,
      createdRuntime,
      ownership,
    );
    assertBoundary();
    if (!recovered.ok) {
      throw constructionErrorForStartupCode(recovered.error.code, confirmedOwnershipContention);
    }
    const recoveredLifecycle = recovered.value;
    lifecycle = recoveredLifecycle;
    assertBoundary();
    await runFactoryPhase(input, startupSignal, () =>
      dependencies.recoverContextStartup(
        ownedStore,
        recoveredLifecycle,
        workspace.workspaceKey,
        startupSignal,
      ),
    );
    assertBoundary();
    await runFactoryPhase(input, startupSignal, () =>
      dependencies.generationStartupCheckpoint("participants", startupSignal),
    );
    assertBoundary();
    const createdParticipantOperations = new ParticipantOperationGate();
    participantOperations = createdParticipantOperations;
    assertBoundary();
    const createdDeletion = new ParticipantDeletionLifecycle({
      requests: ownedStore,
      presence: native,
      notifications: createdRuntime,
      contexts: ownedStore,
      contextNotifications: createdContextRuntime,
      operations: createdParticipantOperations,
      lifecycle: recoveredLifecycle,
      workspaceKey: workspace.workspaceKey,
      directory: workspace.directory,
      projectId: workspace.projectId,
    });
    deletion = createdDeletion;
    assertBoundary();
    const createdParticipantStop = new ParticipantStopLifecycle({
      requests: ownedStore,
      activity: native,
      operations: createdParticipantOperations,
      notifications: createdRuntime,
      contexts: ownedStore,
      contextNotifications: createdContextRuntime,
      lifecycle: recoveredLifecycle,
      workspaceKey: workspace.workspaceKey,
    });
    participantStop = createdParticipantStop;
    assertBoundary();
    await runFactoryPhase(input, startupSignal, () =>
      dependencies.generationStartupCheckpoint("exporter", startupSignal),
    );
    assertBoundary();
    try {
      exporter = dependencies.createExporter(options, {
        ...input.pluginInput,
        directory: workspace.directory,
        worktree: workspace.worktree,
      });
    } catch {
      console.warn("Session export is unavailable because secure initialization failed.");
      exporter = { adapter: unavailableSessionExporter };
    }
    assertBoundary();
    await runFactoryPhase(input, startupSignal, () =>
      dependencies.generationStartupCheckpoint("advisory", startupSignal),
    );
    assertBoundary();
    advisory = dependencies.createAdvisoryLockHooks({ native, lifecycle: recoveredLifecycle });
    assertBoundary();
    const contracts = constructToolContracts({
      options,
      workspaceKey: workspace.workspaceKey,
      native,
      store: ownedStore,
      runtime: createdRuntime,
      contextRuntime: createdContextRuntime,
      lifecycle: recoveredLifecycle,
      participantOperations: createdParticipantOperations,
      exporter: exporter.adapter,
      advisoryLockWake: advisory.wake,
      ...(advisory.notifications ? { advisoryLockNotifications: advisory.notifications } : {}),
    });
    assertBoundary();
    const chat = createChatMessagesTransform(
      {
        readiness: recoveredLifecycle,
        contexts: ownedStore,
        participantOperations,
        notifications: createdContextRuntime,
        targetEligibility: native,
      },
      {
        workspaceKey: workspace.workspaceKey,
        fencingToken: recoveredLifecycle.fencingToken,
        abort: recoveredLifecycle.effectSignal,
      },
      input.chatBookkeeping,
    );
    assertBoundary();
    const event: EventHook = async ({ event }) => {
      await createdParticipantStop.handle(event);
      await createdDeletion.handle(event);
    };
    generation = new CommunicatorGeneration(
      ownedStore,
      createdRuntime,
      createdContextRuntime,
      recoveredLifecycle,
      new ActiveInvocationRegistry(),
      createdParticipantOperations,
      createdDeletion,
      createdParticipantStop,
      contracts,
      event,
      chat,
      exporter.drain,
      exporter.dispose,
      advisory.drain,
      advisory.dispose,
    );
    assertBoundary();
    const lifecycleFailure = constructionErrorForLifecycle(recoveredLifecycle);
    if (lifecycleFailure) throw lifecycleFailure;
    disposeFactoryStartupControl(startupControl);
    return generation;
  } catch (cause: unknown) {
    try {
      startupControl.dispose();
    } catch {}
    const resources = {
      store,
      lifecycle,
      contextRuntime,
      runtime,
      participantOperations,
      deletion,
      participantStop,
      exporter,
      advisory,
    };
    if (cause instanceof InterruptedFactoryPhase) {
      quiescePartialGeneration(resources);
      void cause.settlement
        .then(() => cleanupFailedGeneration(generation, resources))
        .catch(() => undefined);
      throw sanitizeGenerationConstructionError(cause.cause);
    }
    await cleanupFailedGeneration(generation, resources);
    throw sanitizeGenerationConstructionError(cause);
  }
}
