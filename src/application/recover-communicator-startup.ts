import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import {
  CommunicatorStartupRecoveryLifecycle,
  type CommunicatorStartupRecoverySummary,
  markCommunicatorLifecycleReady,
} from "./communicator-startup-lifecycle";
import type {
  ClockPort,
  CurrentWorkspaceMembershipPort,
  DeliveryPersistencePort,
  NativeQueueAdmissionPort,
  OwnershipPort,
  RecoveryStartupBarrierPort,
} from "./delivery-ports";
import { inspectStartupBarrier } from "./message-recovery-boundaries";
import {
  classifyStaleMessageDeliveries,
  recoverPreparedMessageDeliveries,
} from "./recover-message-deliveries";
import {
  classifyStaleSessionRequests,
  expireDueSessionRequests,
  recoverPreparedSessionRequests,
} from "./recover-session-requests";
import {
  RequestDeadlineScheduler,
  type RequestDeadlineSchedulerFault,
  type RequestDeadlineTimerPort,
} from "./request-deadline-scheduler";
import {
  drainRequestMaintenance,
  requestStartupResultExpiryHardBudget,
} from "./request-maintenance";
import type {
  NativeSteerAdmissionPort,
  RequestAdmissionPersistencePort,
  RequestDeadlinePersistencePort,
  RequestParticipantActivityPort,
  RequestRecoveryPersistencePort,
  RequestResultRetentionPersistencePort,
  RequestRetentionPersistencePort,
} from "./request-ports";
import type { RequestRuntime, RequestRuntimeStopReason } from "./request-runtime";
import { operationControlStopped, readSafeClockMs } from "./safe-clock";
import {
  createLinkedStartupEffectControl,
  type StartupDeadlineTimerPort,
} from "./startup-effect-control";

export interface CommunicatorStartupRecoveryPorts {
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly deliveries: DeliveryPersistencePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly requests: RequestRecoveryPersistencePort &
    RequestAdmissionPersistencePort &
    RequestDeadlinePersistencePort;
  readonly activity: RequestParticipantActivityPort;
  readonly nativeSteer: NativeSteerAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly startupBarrier: RecoveryStartupBarrierPort;
  readonly clock: ClockPort;
  readonly runtime: RequestRuntime;
  readonly resultRetention: RequestResultRetentionPersistencePort;
  readonly requestRetention: RequestRetentionPersistencePort;
}

export {
  CommunicatorStartupRecoveryLifecycle,
  type CommunicatorStartupRecoverySummary,
} from "./communicator-startup-lifecycle";

export interface CommunicatorStartupRecoveryInput {
  readonly workspaceKey: WorkspaceKey;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
  readonly limit: number;
  readonly timers?: RequestDeadlineTimerPort;
  readonly startupTimers?: StartupDeadlineTimerPort;
  readonly nowMonotonicMs?: () => number;
}

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
  return {
    ok: true,
    value: {
      expiredResults: result.expiredResults,
      retainedRequestsDeleted: result.deletedRequests,
      retainedRateEventsDeleted: result.deletedRateEvents,
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
      staleMessages: staleMessages.value,
      staleRequests: staleRequests.value,
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scheduler settlement and the final abort, clock, and ownership race checks form one readiness commit boundary.
async function startReadyLifecycle(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
  fencingToken: FencingToken,
  summary: Readonly<CommunicatorStartupRecoverySummary>,
  signal: AbortSignal,
): Promise<DomainResult<CommunicatorStartupRecoveryLifecycle>> {
  let lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  const scheduler = new RequestDeadlineScheduler({
    requests: ports.requests,
    notifications: ports.runtime,
    fencingToken,
    workspaceKey: input.workspaceKey,
    maintenance: {
      resultRetention: ports.resultRetention,
      requestRetention: ports.requestRetention,
    },
    ...(input.timers ? { timers: input.timers } : {}),
    ...(input.nowMonotonicMs ? { nowMonotonicMs: input.nowMonotonicMs } : {}),
    onFault: (fault: RequestDeadlineSchedulerFault) => {
      lifecycle?.stop(fault.code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
      return undefined;
    },
  });
  lifecycle = new CommunicatorStartupRecoveryLifecycle(
    fencingToken,
    scheduler,
    summary,
    ports.runtime,
  );
  const readiness = await runUntilAborted(signal, () => scheduler.startAndWaitReady());
  if (readiness.kind === "aborted") {
    const fault = scheduler.fault;
    lifecycle.stop(fault?.code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
    return fault
      ? startupFailure(
          fault.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
          "Request deadline scheduler failed initial readiness.",
        )
      : startupFailure("ownership_lost", "Startup scheduler readiness was interrupted.");
  }
  if (readiness.kind === "rejected") {
    lifecycle.stop("shutdown", scheduler.fault);
    return startupFailure("storage_unavailable", "Request deadline scheduler readiness rejected.");
  }
  if (!readiness.value.ok) {
    const fault = readiness.value.fault;
    lifecycle.stop(fault.code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
    return startupFailure(
      fault.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
      "Request deadline scheduler failed initial readiness.",
    );
  }
  const nowMs = readSafeClockMs(ports.clock);
  if (signal.aborted || nowMs === undefined || nowMs >= input.deadlineMs) {
    lifecycle.stop("ownership_lost", scheduler.fault);
    return startupFailure("ownership_lost", "Startup readiness was interrupted.");
  }
  const finalOwnership = await runUntilAborted(signal, () =>
    ports.ownership.isCurrent(fencingToken),
  );
  if (finalOwnership.kind === "aborted") {
    const fault = scheduler.fault;
    lifecycle.stop(
      fault?.code === "ownership_lost" ? "ownership_lost" : fault ? "shutdown" : "ownership_lost",
      fault,
    );
    return fault
      ? startupFailure(
          fault.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
          "Request deadline scheduler lost readiness.",
        )
      : startupFailure("ownership_lost", "Startup readiness was interrupted.");
  }
  if (finalOwnership.kind === "rejected") {
    const ownershipLost = finalOwnership.cause instanceof OwnershipLostFault;
    lifecycle.stop(ownershipLost ? "ownership_lost" : "shutdown", scheduler.fault);
    return startupFailure(
      ownershipLost ? "ownership_lost" : "storage_unavailable",
      ownershipLost
        ? "Startup ownership was lost."
        : "Startup final ownership verification failed.",
    );
  }
  if (finalOwnership.value !== true) {
    lifecycle.stop("ownership_lost", scheduler.fault);
    return startupFailure("ownership_lost", "Startup ownership was lost.");
  }
  // Readiness is one atomic certification boundary. The ownership await can yield to every other
  // lifecycle input, so none of the earlier observations may be reused here.
  const finalNowMs = readSafeClockMs(ports.clock);
  const schedulerFault = scheduler.fault;
  if (
    signal.aborted ||
    finalNowMs === undefined ||
    finalNowMs >= input.deadlineMs ||
    scheduler.status !== "ready" ||
    schedulerFault !== undefined ||
    lifecycle.status !== "starting"
  ) {
    const storageFault = schedulerFault !== undefined || scheduler.status === "faulted";
    lifecycle.stop(
      schedulerFault?.code === "ownership_lost"
        ? "ownership_lost"
        : storageFault
          ? "shutdown"
          : "ownership_lost",
      schedulerFault,
    );
    return startupFailure(
      schedulerFault?.code === "ownership_lost"
        ? "ownership_lost"
        : storageFault
          ? "storage_unavailable"
          : "ownership_lost",
      storageFault
        ? "Request deadline scheduler lost readiness."
        : "Startup readiness was interrupted.",
    );
  }
  markCommunicatorLifecycleReady(lifecycle);
  return { ok: true, value: lifecycle };
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
  let scheduler: RequestDeadlineScheduler | undefined;
  let lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  const stop = (result: DomainResult<never>): DomainResult<never> => {
    const reason: RequestRuntimeStopReason =
      !result.ok && result.error.code === "ownership_lost" ? "ownership_lost" : "shutdown";
    if (lifecycle) lifecycle.stop(reason);
    else {
      scheduler?.stop();
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
    scheduler = lifecycle.scheduler;
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
