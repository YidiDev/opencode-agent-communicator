import type { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import type { CommunicatorStartupRecoveryLifecycle } from "../application/communicator-startup-lifecycle";
import type { ContextAdmissionRuntime } from "../application/context-admission-runtime";
import type { ParticipantDeletionLifecycle } from "../application/participant-deletion-lifecycle";
import type { ParticipantOperationGate } from "../application/participant-operation-gate";
import type { ParticipantStopLifecycle } from "../application/participant-stop-lifecycle";
import type { RequestRuntime } from "../application/request-runtime";
import type { CompositionDependencies } from "./composition-dependencies";

export interface PartialGenerationResources {
  readonly store: LinuxBunSqliteStore | undefined;
  readonly lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  readonly contextRuntime: ContextAdmissionRuntime;
  readonly runtime: RequestRuntime;
  readonly participantOperations: ParticipantOperationGate | undefined;
  readonly deletion: ParticipantDeletionLifecycle | undefined;
  readonly participantStop: ParticipantStopLifecycle | undefined;
  readonly exporter: ReturnType<CompositionDependencies["createExporter"]> | undefined;
  readonly advisory: ReturnType<CompositionDependencies["createAdvisoryLockHooks"]> | undefined;
}

async function ignoreCleanup(operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {}
}

export async function rollbackPartialGeneration(
  resources: PartialGenerationResources,
): Promise<void> {
  await ignoreCleanup(() => resources.lifecycle?.stop("shutdown", "contract_fault"));
  await ignoreCleanup(() => resources.participantStop?.dispose());
  await ignoreCleanup(() => resources.deletion?.dispose());
  await ignoreCleanup(() => resources.contextRuntime.stop("shutdown"));
  await ignoreCleanup(() => resources.runtime.stop("shutdown"));
  await ignoreCleanup(() => resources.advisory?.dispose?.());
  await ignoreCleanup(() => resources.participantOperations?.close());
  await ignoreCleanup(() => resources.participantOperations?.drain());
  await ignoreCleanup(() => resources.advisory?.drain?.());
  await ignoreCleanup(() => resources.lifecycle?.scheduler.drain());
  await ignoreCleanup(() => resources.exporter?.drain?.());
  await ignoreCleanup(() => resources.exporter?.dispose?.());
  await ignoreCleanup(() => resources.store?.close());
}
