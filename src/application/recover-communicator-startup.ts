import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { startReadyLifecycle } from "./communicator-ready-lifecycle";
import type {
  CommunicatorStartupRecoveryLifecycle,
  CommunicatorStartupRecoverySummary,
} from "./communicator-startup-lifecycle";
import type {
  CommunicatorStartupRecoveryInput,
  CommunicatorStartupRecoveryPorts,
} from "./communicator-startup-types";
import type { RecoveryStartupBarrierPort } from "./delivery-ports";
import { drainDeliveryRetention } from "./delivery-retention";
import { inspectStartupBarrier } from "./message-recovery-boundaries";
import {
  ParticipantDeletionReconciliationFault,
  reconcileParticipantDeletions,
} from "./participant-deletion-reconciliation";
import {
  classifyStaleMessageDeliveries,
  recoverPreparedMessageDeliveries,
} from "./recover-message-deliveries";
import {
  classifyStaleSessionRequests,
  expireDueSessionRequests,
  recoverPreparedSessionRequests,
} from "./recover-session-requests";
import { recoverSessionStarts } from "./recover-session-starts";
import {
  drainRequestMaintenance,
  requestStartupResultExpiryHardBudget,
} from "./request-maintenance";
import type { RequestRuntimeStopReason } from "./request-runtime";
import { operationControlStopped, readSafeClockMs } from "./safe-clock";
import { drainStartMaintenance } from "./start-maintenance";
import { createLinkedStartupEffectControl } from "./startup-effect-control";

export {
  CommunicatorStartupRecoveryLifecycle,
  type CommunicatorStartupRecoverySummary,
} from "./communicator-startup-lifecycle";

export type {
  CommunicatorStartupRecoveryInput,
  CommunicatorStartupRecoveryPorts,
} from "./communicator-startup-types";

function startupFailure(
  code: "ownership_lost" | "storage_unavailable",
  message: string,
): DomainResult<never> {
  return domainFailure(code, message, code === "storage_unavailable");
}

function stopForFailure(
  ports: CommunicatorStartupRecoveryPorts,
  result: DomainResult<never>,
): DomainResult<never> {
  const reason: RequestRuntimeStopReason =
    !result.ok && result.error.code === "ownership_lost" ? "ownership_lost" : "shutdown";
  ports.runtime.stop(reason);
  return result;
}

function validStartupInput(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
): boolean {
  if (
    !validateWorkspaceKey(input.workspaceKey).ok ||
    typeof input.abort !== "object" ||
    input.abort === null ||
    typeof input.abort.aborted !== "boolean" ||
    !Number.isSafeInteger(input.deadlineMs) ||
    input.deadlineMs < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    return false;
  }
  const now = readSafeClockMs(ports.clock);
  return !input.abort.aborted && now !== undefined && now < input.deadlineMs;
}

function startupControlStopped(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
): boolean {
  return operationControlStopped(ports.clock, input.abort, input.deadlineMs);
}

async function verifyStartupOwnership(
  ports: CommunicatorStartupRecoveryPorts,
  fencingToken: FencingToken,
  signal: AbortSignal,
): Promise<DomainResult<undefined>> {
  const current = await runUntilAborted(signal, () => ports.ownership.isCurrent(fencingToken));
  if (current.kind === "aborted" || (current.kind === "settled" && current.value !== true)) {
    return startupFailure("ownership_lost", "Startup ownership was lost.");
  }
  if (current.kind === "rejected") {
    return startupFailure(
      current.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      current.cause instanceof OwnershipLostFault
        ? "Startup ownership was lost."
        : "Startup ownership verification failed.",
    );
  }
  return { ok: true, value: undefined };
}

async function runHygiene(
  ports: CommunicatorStartupRecoveryPorts,
  fencingToken: FencingToken,
  workspaceKey: WorkspaceKey,
  shouldStop: () => boolean,
  signal: AbortSignal,
): Promise<
  DomainResult<{
    readonly expiredResults: number;
    readonly retainedRequestsDeleted: number;
    readonly retainedRateEventsDeleted: number;
    readonly retainedStartOperationsDeleted: number;
    readonly retainedStartRateEventsDeleted: number;
    readonly retainedDeliveriesDeleted: number;
    readonly retainedDeliveryRateEventsDeleted: number;
  }>
> {
  const result = await drainRequestMaintenance({
    ports: { resultRetention: ports.resultRetention, requestRetention: ports.requestRetention },
    fencingToken,
    workspaceKey,
    shouldStop,
    abort: signal,
    resultExpiryHardBudget: requestStartupResultExpiryHardBudget,
  });
  if (!result.ok) {
    return startupFailure(
      result.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
      "Request maintenance hygiene failed.",
    );
  }
  const deliveryRetention = await drainDeliveryRetention({
    persistence: ports.deliveries,
    fencingToken,
    workspaceKey,
    shouldStop,
    abort: signal,
  });
  if (!deliveryRetention.ok) {
    return startupFailure(
      deliveryRetention.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
      "Delivery maintenance hygiene failed.",
    );
  }
  const startResult = ports.startLimits
    ? await drainStartMaintenance({
        starts: ports.starts,
        limits: ports.startLimits,
        fencingToken,
        workspaceKey,
        nowMs: ports.clock.nowMs(),
        shouldStop,
        abort: signal,
      })
    : { ok: true as const, deletedOperations: 0, deletedRateEvents: 0 };
  if (!startResult.ok) {
    return startupFailure(
      startResult.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
      "Start-operation maintenance hygiene failed.",
    );
  }
  return {
    ok: true,
    value: {
      expiredResults: result.expiredResults,
      retainedRequestsDeleted: result.deletedRequests,
      retainedRateEventsDeleted: result.deletedRateEvents,
      retainedStartOperationsDeleted: startResult.deletedOperations,
      retainedStartRateEventsDeleted: startResult.deletedRateEvents,
      retainedDeliveriesDeleted: deliveryRetention.deletedDeliveries,
      retainedDeliveryRateEventsDeleted: deliveryRetention.deletedRateEvents,
    },
  };
}

async function runStartupPhases(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
  fencingToken: FencingToken,
  startupBarrier: Awaited<ReturnType<RecoveryStartupBarrierPort["establish"]>>,
  signal: AbortSignal,
): Promise<DomainResult<Readonly<CommunicatorStartupRecoverySummary>>> {
  const phaseInput = {
    workspaceKey: input.workspaceKey,
    fencingToken,
    startupBarrier,
    abort: signal,
    deadlineMs: input.deadlineMs,
    limit: input.limit,
    effectSignal: signal,
  };
  const messagePorts = {
    membership: ports.membership,
    deliveries: ports.deliveries,
    nativeQueue: ports.nativeQueue,
    ownership: ports.ownership,
    startupBarrier: ports.startupBarrier,
    clock: ports.clock,
  };
  const requestPorts = {
    requests: ports.requests,
    activity: ports.activity,
    nativeSteer: ports.nativeSteer,
    ownership: ports.ownership,
    notifications: ports.runtime,
    clock: ports.clock,
  };
  const staleMessages = await classifyStaleMessageDeliveries(messagePorts, phaseInput);
  if (!staleMessages.ok) return staleMessages;
  const staleRequests = await classifyStaleSessionRequests(requestPorts, phaseInput);
  if (!staleRequests.ok) return staleRequests;
  let participantDeletions: Awaited<ReturnType<typeof reconcileParticipantDeletions>>;
  try {
    participantDeletions = await reconcileParticipantDeletions(
      {
        requests: ports.requests,
        presence: ports.participantPresence,
        notifications: ports.runtime,
        lifecycle: { fencingToken },
        workspaceKey: input.workspaceKey,
      },
      signal,
    );
  } catch (cause: unknown) {
    const ownershipLost =
      cause instanceof ParticipantDeletionReconciliationFault && cause.code === "ownership_lost";
    return startupFailure(
      ownershipLost ? "ownership_lost" : "storage_unavailable",
      "Participant deletion startup reconciliation failed.",
    );
  }
  const staleStarts = await recoverSessionStarts(ports.starts, ports.clock, {
    fencingToken,
    workspaceKey: input.workspaceKey,
    abort: signal,
    nativeStart: ports.nativeStart,
  });
  const linkedInput = { ...input, abort: signal };
  if (startupControlStopped(ports, linkedInput)) {
    return startupFailure("ownership_lost", "Startup ownership was lost.");
  }
  const currentBeforeDue = await verifyStartupOwnership(ports, fencingToken, signal);
  if (!currentBeforeDue.ok) return currentBeforeDue;
  const dueBefore = await expireDueSessionRequests(requestPorts, phaseInput);
  if (!dueBefore.ok) return dueBefore;
  const preparedMessages = await recoverPreparedMessageDeliveries(messagePorts, phaseInput);
  if (!preparedMessages.ok) return preparedMessages;
  const preparedRequests = await recoverPreparedSessionRequests(requestPorts, phaseInput);
  if (!preparedRequests.ok) return preparedRequests;
  const dueAfter = await expireDueSessionRequests(requestPorts, phaseInput);
  if (!dueAfter.ok) return dueAfter;
  const hygiene = await runHygiene(
    ports,
    fencingToken,
    input.workspaceKey,
    () => startupControlStopped(ports, linkedInput),
    signal,
  );
  if (!hygiene.ok) return hygiene;
  if (startupControlStopped(ports, linkedInput)) {
    return startupFailure("ownership_lost", "Startup ownership was lost.");
  }
  const currentAfterHygiene = await verifyStartupOwnership(ports, fencingToken, signal);
  if (!currentAfterHygiene.ok) return currentAfterHygiene;
  return {
    ok: true,
    value: Object.freeze({
      participantDeletionCandidates: participantDeletions.candidates,
      participantDeletionsObserved: participantDeletions.absent,
      participantDeletionUnknown: participantDeletions.unknown,
      participantRequestsTerminalized: participantDeletions.terminalized,
      staleMessages: staleMessages.value,
      staleRequests: staleRequests.value,
      preparedStartsAwaitingApproval: staleStarts.preparedAwaitingInvocationApproval,
      startCreationOutcomesUnknown: staleStarts.creationOutcomesUnknown,
      startTitleOutcomesUnknown: staleStarts.titleOutcomesUnknown,
      startAdmissionsUnknown: staleStarts.admissionsUnknown,
      dueRequestsBeforePrepared: dueBefore.value,
      preparedMessagesSubmitted: preparedMessages.value.submitted,
      preparedMessagesCancelled: preparedMessages.value.cancelled,
      preparedRequestsObserved: preparedRequests.value.observed,
      preparedRequestsSubmitted: preparedRequests.value.submitted,
      preparedRequestsSkipped: preparedRequests.value.skipped,
      requestsTerminalizedAtClaim: preparedRequests.value.terminalizedAtClaim,
      dueRequestsAfterPrepared: dueAfter.value,
      ...hygiene.value,
    }),
  };
}

export async function recoverCommunicatorStartup(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
): Promise<DomainResult<CommunicatorStartupRecoveryLifecycle>> {
  if (!validStartupInput(ports, input)) {
    return stopForFailure(
      ports,
      domainFailure("invalid_arguments", "Startup recovery control is invalid.", false),
    );
  }
  const effectControl = createLinkedStartupEffectControl({
    caller: input.abort,
    runtime: ports.runtime.effectSignal,
    deadlineMs: input.deadlineMs,
    clock: ports.clock,
    ...(input.startupTimers ? { timers: input.startupTimers } : {}),
  });
  if (!effectControl || effectControl.signal.aborted) {
    try {
      effectControl?.dispose();
    } catch {
      // Invalid injected timer cleanup fails startup closed.
    }
    return stopForFailure(
      ports,
      domainFailure("invalid_arguments", "Startup deadline timer is invalid.", false),
    );
  }
  let lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  const stop = (result: DomainResult<never>): DomainResult<never> => {
    const reason: RequestRuntimeStopReason =
      !result.ok && result.error.code === "ownership_lost" ? "ownership_lost" : "shutdown";
    if (lifecycle) lifecycle.stop(reason);
    else {
      ports.runtime.stop(reason);
    }
    return result;
  };
  try {
    const acquired = await runUntilAborted(effectControl.signal, () => ports.ownership.acquire());
    if (acquired.kind === "aborted") {
      return stop(
        startupFailure("ownership_lost", "Startup ownership acquisition was interrupted."),
      );
    }
    if (acquired.kind === "rejected") throw acquired.cause;
    const fencingToken = acquired.value;
    const established = await runUntilAborted(effectControl.signal, () =>
      ports.startupBarrier.establish(fencingToken, {
        abort: effectControl.signal,
        deadlineMs: input.deadlineMs,
      }),
    );
    if (established.kind === "aborted") {
      return stop(
        startupFailure("ownership_lost", "Startup barrier establishment was interrupted."),
      );
    }
    if (established.kind === "rejected") throw established.cause;
    const startupBarrier = inspectStartupBarrier(established.value, fencingToken);
    if (!startupBarrier) {
      return stop(startupFailure("storage_unavailable", "Startup barrier was malformed."));
    }
    const phases = await runStartupPhases(
      ports,
      input,
      fencingToken,
      startupBarrier,
      effectControl.signal,
    );
    if (!phases.ok) return stop(phases);
    const summary = phases.value;
    // This readiness boundary is also the creation gate: ordinary request creation must not be
    // exposed until the returned lifecycle exists, preventing inserts behind recovery keysets.
    const ready = await startReadyLifecycle(
      ports,
      input,
      fencingToken,
      summary,
      effectControl.signal,
    );
    if (!ready.ok) return ready;
    lifecycle = ready.value;
    effectControl.dispose();
    return ready;
  } catch (cause: unknown) {
    return stop(
      startupFailure(
        cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        cause instanceof OwnershipLostFault
          ? "Startup ownership was lost."
          : "Communicator startup recovery failed.",
      ),
    );
  } finally {
    try {
      effectControl.dispose();
    } catch {
      // Composition owns the store; callers must close it after failure to release its lease.
    }
  }
}
