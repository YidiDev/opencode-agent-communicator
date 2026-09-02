import type { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import type { CommunicatorStartupRecoveryLifecycle } from "../application/communicator-startup-lifecycle";
import type { ContextAdmissionRuntime } from "../application/context-admission-runtime";
import { observeNativePromiseRejection } from "../application/native-promise-observation";
import type { ParticipantDeletionLifecycle } from "../application/participant-deletion-lifecycle";
import type { ParticipantOperationGate } from "../application/participant-operation-gate";
import type { ParticipantStopLifecycle } from "../application/participant-stop-lifecycle";
import type { RequestRuntime } from "../application/request-runtime";
import type { CompositionDependencies } from "./composition-dependencies";

export interface PartialGenerationResources {
  readonly store: LinuxBunSqliteStore | undefined;
  readonly lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  readonly contextRuntime: ContextAdmissionRuntime | undefined;
  readonly runtime: RequestRuntime | undefined;
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
  quiescePartialGeneration(resources);
  await ignoreCleanup(() => resources.participantStop?.dispose());
  await ignoreCleanup(() => resources.deletion?.dispose());
  await ignoreCleanup(() => resources.participantOperations?.drain());
  await ignoreCleanup(() => resources.advisory?.drain?.());
  await ignoreCleanup(() => resources.lifecycle?.scheduler.drain());
  await ignoreCleanup(() => resources.exporter?.drain?.());
  await ignoreCleanup(() => resources.exporter?.dispose?.());
  await ignoreCleanup(() => resources.store?.close());
}

export function quiescePartialGeneration(resources: PartialGenerationResources): void {
  const ignore = (operation: () => void): void => {
    try {
      operation();
    } catch {}
  };
  ignore(() => resources.lifecycle?.stop("shutdown", "contract_fault"));
  ignore(() => resources.contextRuntime?.stop("shutdown"));
  ignore(() => resources.runtime?.stop("shutdown"));
  ignore(() => resources.advisory?.dispose?.());
  ignore(() => resources.participantOperations?.close());
  const observeDisposal = (operation: (() => Promise<void>) | undefined): void => {
    if (!operation) return;
    try {
      observeNativePromiseRejection(operation());
    } catch {}
  };
  const deletion = resources.deletion;
  const participantStop = resources.participantStop;
  observeDisposal(deletion ? () => deletion.dispose() : undefined);
  observeDisposal(participantStop ? () => participantStop.dispose() : undefined);
}

export async function inspectTakeoverAndDispose(resource: {
  ownershipTakeoverDelayMs(): number;
  disposeResources(): Promise<void>;
}): Promise<number> {
  let delayMs: number | undefined;
  let inspectionFailure: unknown;
  try {
    delayMs = resource.ownershipTakeoverDelayMs();
  } catch (cause: unknown) {
    inspectionFailure = cause;
  }
  try {
    await resource.disposeResources();
  } catch (cleanupFailure: unknown) {
    if (inspectionFailure === undefined) throw cleanupFailure;
  }
  if (inspectionFailure !== undefined) throw inspectionFailure;
  return delayMs as number;
}

interface QuiescedGenerationResources {
  drainInvocations(): Promise<"drained" | "timed_out">;
  settleInvocations(): Promise<void>;
  disposeResources(): Promise<void>;
}

interface UnpublishedGenerationResources extends QuiescedGenerationResources {
  quiesce(disposal?: boolean): void;
  shutdownUnpublished(): void;
}

const generationDisposals = new WeakMap<object, Promise<void>>();

export function disposeUnpublishedGeneration(
  generation: UnpublishedGenerationResources,
  hostDisposal = false,
): Promise<void> {
  const existing = generationDisposals.get(generation);
  if (existing) return existing;
  try {
    if (hostDisposal) generation.quiesce(true);
    else generation.shutdownUnpublished();
  } catch {}
  return disposeQuiescedGeneration(generation);
}

export function disposeQuiescedGeneration(generation: QuiescedGenerationResources): Promise<void> {
  const existing = generationDisposals.get(generation);
  if (existing) return existing;
  const disposal = settleAndDisposeGeneration(generation);
  generationDisposals.set(generation, disposal);
  return disposal;
}

export async function disposeQuiescedGenerationStrict(
  generation: QuiescedGenerationResources,
): Promise<void> {
  let firstError: unknown;
  let requiresSettlement = false;
  try {
    requiresSettlement = (await generation.drainInvocations()) !== "drained";
  } catch (cause: unknown) {
    firstError = cause;
    requiresSettlement = true;
  }
  if (requiresSettlement) {
    try {
      await generation.settleInvocations();
    } catch (cause: unknown) {
      throw firstError ?? cause;
    }
  }
  try {
    await generation.disposeResources();
  } catch (cause: unknown) {
    firstError ??= cause;
  }
  if (firstError !== undefined) throw firstError;
}

async function settleAndDisposeGeneration(generation: QuiescedGenerationResources): Promise<void> {
  let requiresSettlement = false;
  try {
    requiresSettlement = (await generation.drainInvocations()) !== "drained";
  } catch {
    requiresSettlement = true;
  }
  if (requiresSettlement) {
    try {
      await generation.settleInvocations();
    } catch {
      return;
    }
  }
  try {
    await generation.disposeResources();
  } catch {}
}
