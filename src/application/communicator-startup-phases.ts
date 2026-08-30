import type { FencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { CommunicatorStartupRecoverySummary } from "./communicator-startup-lifecycle";
import type {
  CommunicatorStartupRecoveryInput,
  CommunicatorStartupRecoveryPorts,
} from "./communicator-startup-types";
import type { RecoveryStartupBarrierPort } from "./delivery-ports";
import { drainDeliveryRetention } from "./delivery-retention";
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
import { operationControlStopped } from "./safe-clock";
import { drainStartMaintenance } from "./start-maintenance";

function startupFailure(
  code: "ownership_lost" | "storage_unavailable",
  message: string,
): DomainResult<never> {
  return domainFailure(code, message, code === "storage_unavailable");
}

async function runHygiene(
  ports: CommunicatorStartupRecoveryPorts,
  fencingToken: FencingToken,
  input: CommunicatorStartupRecoveryInput,
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
  const shouldStop = (): boolean => operationControlStopped(ports.clock, signal, input.deadlineMs);
  const result = await drainRequestMaintenance({
    ports: { resultRetention: ports.resultRetention, requestRetention: ports.requestRetention },
    fencingToken,
    workspaceKey: input.workspaceKey,
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
    workspaceKey: input.workspaceKey,
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
        workspaceKey: input.workspaceKey,
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

export async function runCommunicatorStartupPhases(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
  fencingToken: FencingToken,
  startupBarrier: Awaited<ReturnType<RecoveryStartupBarrierPort["establish"]>>,
  signal: AbortSignal,
  verifyOwnership: () => Promise<DomainResult<undefined>>,
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
    nativeQueue: ports.nativeQueue,
    ...(ports.requestStarts ? { requestStarts: ports.requestStarts } : {}),
    ownership: ports.ownership,
    notifications: ports.runtime,
    clock: ports.clock,
  };
  const staleMessages = await classifyStaleMessageDeliveries(messagePorts, phaseInput);
  if (!staleMessages.ok) return staleMessages;
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
    ...(ports.requestStarts ? { requestStarts: ports.requestStarts } : {}),
    requests: ports.requests,
    membership: ports.membership,
    ownership: ports.ownership,
    ...(ports.digest ? { digest: ports.digest } : {}),
  });
  const staleRequests = await classifyStaleSessionRequests(requestPorts, phaseInput);
  if (!staleRequests.ok) return staleRequests;
  if (operationControlStopped(ports.clock, signal, input.deadlineMs)) {
    return startupFailure("ownership_lost", "Startup ownership was lost.");
  }
  const currentBeforeDue = await verifyOwnership();
  if (!currentBeforeDue.ok) return currentBeforeDue;
  const dueBefore = await expireDueSessionRequests(requestPorts, phaseInput);
  if (!dueBefore.ok) return dueBefore;
  const preparedMessages = await recoverPreparedMessageDeliveries(messagePorts, phaseInput);
  if (!preparedMessages.ok) return preparedMessages;
  const preparedRequests = await recoverPreparedSessionRequests(requestPorts, phaseInput);
  if (!preparedRequests.ok) return preparedRequests;
  const dueAfter = await expireDueSessionRequests(requestPorts, phaseInput);
  if (!dueAfter.ok) return dueAfter;
  const hygiene = await runHygiene(ports, fencingToken, input, signal);
  if (!hygiene.ok) return hygiene;
  if (operationControlStopped(ports.clock, signal, input.deadlineMs)) {
    return startupFailure("ownership_lost", "Startup ownership was lost.");
  }
  const currentAfterHygiene = await verifyOwnership();
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
