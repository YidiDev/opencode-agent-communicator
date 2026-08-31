import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { OpenCodeNativeAdapter } from "../adapters/native/opencode-1-18";
import type { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import {
  OwnershipUnavailableError,
  sqliteStoreDefaultTakeoverGraceMs,
} from "../adapters/store/store-types";
import type { CommunicatorStartupRecoveryLifecycle } from "../application/communicator-startup-lifecycle";
import { ParticipantDeletionLifecycle } from "../application/participant-deletion-lifecycle";
import { ParticipantOperationGate } from "../application/participant-operation-gate";
import { ParticipantStopLifecycle } from "../application/participant-stop-lifecycle";
import { ActiveInvocationRegistry } from "./active-invocations";
import {
  type ChatMessagesTransformBookkeeping,
  createChatMessagesTransform,
} from "./chat-messages-transform";
import {
  assertGenerationStartupActive,
  constructionErrorForStartupCode,
  sanitizeGenerationConstructionError,
} from "./communicator-generation-errors";
import {
  CommunicatorGeneration,
  type CommunicatorToolContracts,
} from "./communicator-generation-instance";
import { rollbackPartialGeneration } from "./communicator-generation-rollback";
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
export async function createCommunicatorGeneration(
  input: CommunicatorGenerationFactoryInput,
): Promise<CommunicatorGeneration> {
  const { dependencies, native, options, workspace } = input;
  const contextRuntime = dependencies.createContextRuntime();
  const runtime = dependencies.createRuntime(contextRuntime);
  let store: LinuxBunSqliteStore | undefined;
  let lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  let participantOperations: ParticipantOperationGate | undefined;
  let deletion: ParticipantDeletionLifecycle | undefined;
  let participantStop: ParticipantStopLifecycle | undefined;
  let exporter: ReturnType<CompositionDependencies["createExporter"]> | undefined;
  let advisory: ReturnType<CompositionDependencies["createAdvisoryLockHooks"]> | undefined;
  let confirmedOwnershipContention = false;
  try {
    assertGenerationStartupActive(input.startupAbort);
    store = dependencies.createStore({
      stateDirectory: options.stateDirectory,
      databaseFileName: `${workspace.workspaceKey.slice(0, 56)}.sqlite3`,
      workspaceKey: workspace.workspaceKey,
      nowWallMs: () => dependencies.generationClock.nowMs(),
      nowMonotonicMs: dependencies.generationMonotonicNowMs,
      takeoverGraceMs: sqliteStoreDefaultTakeoverGraceMs,
    });
    assertGenerationStartupActive(input.startupAbort);
    const ownedStore = store;
    const ownership = {
      acquire: async () => {
        try {
          return await ownedStore.acquire();
        } catch (cause: unknown) {
          if (cause instanceof OwnershipUnavailableError) confirmedOwnershipContention = true;
          throw cause;
        }
      },
      isCurrent: (token: Parameters<LinuxBunSqliteStore["isCurrent"]>[0]) =>
        ownedStore.isCurrent(token),
    };
    const recovered = await dependencies.recoverStartup(
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
        abort: input.startupAbort,
        deadlineMs: input.startupDeadlineMs,
        limit: 100,
        timers: dependencies.generationSchedulerTimers,
        startupTimers: dependencies.generationStartupTimers,
        nowMonotonicMs: dependencies.generationMonotonicNowMs,
      },
    );
    assertGenerationStartupActive(input.startupAbort);
    if (!recovered.ok) {
      throw constructionErrorForStartupCode(recovered.error.code, confirmedOwnershipContention);
    }
    lifecycle = recovered.value;
    assertGenerationStartupActive(input.startupAbort);
    await dependencies.recoverContextStartup(
      store,
      lifecycle,
      workspace.workspaceKey,
      input.startupAbort,
    );
    assertGenerationStartupActive(input.startupAbort);
    await dependencies.generationStartupCheckpoint("participants", input.startupAbort);
    assertGenerationStartupActive(input.startupAbort);
    const createdParticipantOperations = new ParticipantOperationGate();
    participantOperations = createdParticipantOperations;
    assertGenerationStartupActive(input.startupAbort);
    const createdDeletion = new ParticipantDeletionLifecycle({
      requests: store,
      presence: native,
      notifications: runtime,
      contexts: store,
      contextNotifications: contextRuntime,
      operations: createdParticipantOperations,
      lifecycle,
      workspaceKey: workspace.workspaceKey,
      directory: workspace.directory,
      projectId: workspace.projectId,
    });
    deletion = createdDeletion;
    assertGenerationStartupActive(input.startupAbort);
    const createdParticipantStop = new ParticipantStopLifecycle({
      requests: store,
      activity: native,
      operations: createdParticipantOperations,
      notifications: runtime,
      contexts: store,
      contextNotifications: contextRuntime,
      lifecycle,
      workspaceKey: workspace.workspaceKey,
    });
    participantStop = createdParticipantStop;
    await dependencies.generationStartupCheckpoint("exporter", input.startupAbort);
    assertGenerationStartupActive(input.startupAbort);
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
    await dependencies.generationStartupCheckpoint("advisory", input.startupAbort);
    assertGenerationStartupActive(input.startupAbort);
    advisory = dependencies.createAdvisoryLockHooks({ native, lifecycle });
    assertGenerationStartupActive(input.startupAbort);
    const contracts = constructToolContracts({
      options,
      workspaceKey: workspace.workspaceKey,
      native,
      store,
      runtime,
      contextRuntime,
      lifecycle,
      participantOperations: createdParticipantOperations,
      exporter: exporter.adapter,
      advisoryLockWake: advisory.wake,
      ...(advisory.notifications ? { advisoryLockNotifications: advisory.notifications } : {}),
    });
    assertGenerationStartupActive(input.startupAbort);
    const chat = createChatMessagesTransform(
      {
        readiness: lifecycle,
        contexts: store,
        participantOperations,
        notifications: contextRuntime,
        targetEligibility: native,
      },
      {
        workspaceKey: workspace.workspaceKey,
        fencingToken: lifecycle.fencingToken,
        abort: lifecycle.effectSignal,
      },
      input.chatBookkeeping,
    );
    const event: EventHook = async ({ event }) => {
      await createdParticipantStop.handle(event);
      await createdDeletion.handle(event);
    };
    return new CommunicatorGeneration(
      store,
      runtime,
      contextRuntime,
      lifecycle,
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
  } catch (cause: unknown) {
    await rollbackPartialGeneration({
      store,
      lifecycle,
      contextRuntime,
      runtime,
      participantOperations,
      deletion,
      participantStop,
      exporter,
      advisory,
    });
    throw sanitizeGenerationConstructionError(cause);
  }
}
