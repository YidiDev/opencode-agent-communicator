import type { FencingToken } from "../domain/ownership";
import type { CommunicatorReadinessPort } from "./communicator-readiness-port";
import type {
  RequestDeadlineScheduler,
  RequestDeadlineSchedulerFault,
} from "./request-deadline-scheduler";
import type { RequestRuntime, RequestRuntimeStopReason } from "./request-runtime";

export interface CommunicatorStartupRecoverySummary {
  readonly participantDeletionCandidates: number;
  readonly participantDeletionsObserved: number;
  readonly participantDeletionUnknown: number;
  readonly participantRequestsTerminalized: number;
  readonly staleMessages: number;
  readonly staleRequests: number;
  readonly preparedStartsAwaitingApproval: number;
  readonly startCreationOutcomesUnknown: number;
  readonly startTitleOutcomesUnknown: number;
  readonly startAdmissionsUnknown: number;
  readonly dueRequestsBeforePrepared: number;
  readonly preparedMessagesSubmitted: number;
  readonly preparedMessagesCancelled: number;
  readonly preparedRequestsObserved: number;
  readonly preparedRequestsSubmitted: number;
  readonly preparedRequestsSkipped: number;
  readonly requestsTerminalizedAtClaim: number;
  readonly dueRequestsAfterPrepared: number;
  readonly expiredResults: number;
  readonly retainedRequestsDeleted: number;
  readonly retainedRateEventsDeleted: number;
  readonly retainedStartOperationsDeleted: number;
  readonly retainedStartRateEventsDeleted: number;
  readonly retainedDeliveriesDeleted: number;
  readonly retainedDeliveryRateEventsDeleted: number;
}

export type CommunicatorLifecycleStopCause =
  | "ownership_lost"
  | "storage_failure"
  | "contract_fault"
  | "workflow_fault"
  | "host_disposal";

export interface CommunicatorLifecycleStopState {
  readonly cause: CommunicatorLifecycleStopCause;
  readonly reason: RequestRuntimeStopReason;
  readonly recoverable: boolean;
  readonly diagnostic: string;
}

const stopDiagnostics: Readonly<Record<CommunicatorLifecycleStopCause, string>> = Object.freeze({
  ownership_lost: "Communicator ownership ended.",
  storage_failure: "Communicator storage became unavailable.",
  contract_fault: "A communicator port contract failed.",
  workflow_fault: "A communicator workflow faulted.",
  host_disposal: "The communicator host was disposed.",
});

const readyAuthority = Symbol("communicator-startup-ready");

export class CommunicatorStartupRecoveryLifecycle implements CommunicatorReadinessPort {
  private stopValue: CommunicatorLifecycleStopState | undefined;
  private faultValue: RequestDeadlineSchedulerFault | undefined;
  private readyValue = false;
  private readonly stopObservers = new Set<(state: CommunicatorLifecycleStopState) => void>();

  constructor(
    readonly fencingToken: FencingToken,
    readonly scheduler: RequestDeadlineScheduler,
    readonly summary: Readonly<CommunicatorStartupRecoverySummary>,
    private readonly runtime: RequestRuntime,
  ) {}

  get stopReason(): RequestRuntimeStopReason | undefined {
    return this.stopValue?.reason;
  }

  get stopState(): CommunicatorLifecycleStopState | undefined {
    return this.stopValue;
  }

  get schedulerFault(): RequestDeadlineSchedulerFault | undefined {
    return this.faultValue ?? this.scheduler.fault;
  }

  get effectSignal(): AbortSignal {
    return this.runtime.effectSignal;
  }

  get status(): "starting" | "ready" | "stopped" {
    if (this.stopValue !== undefined) return "stopped";
    return this.readyValue ? "ready" : "starting";
  }

  assertReady(): void {
    if (this.status !== "ready") {
      throw new Error("Communicator application lifecycle is not ready for ordinary work.");
    }
  }

  ownershipLost(): void {
    this.stop("ownership_lost", "ownership_lost");
  }

  markReady(authority: symbol): void {
    if (authority !== readyAuthority) throw new Error("Invalid lifecycle ready authority.");
    if (this.stopValue === undefined) this.readyValue = true;
  }

  observeStop(observer: (state: CommunicatorLifecycleStopState) => void): () => void {
    this.stopObservers.add(observer);
    if (this.stopValue) observer(this.stopValue);
    return () => this.stopObservers.delete(observer);
  }

  stop(
    reason: RequestRuntimeStopReason,
    causeOrFault: CommunicatorLifecycleStopCause | RequestDeadlineSchedulerFault = reason ===
    "ownership_lost"
      ? "ownership_lost"
      : "host_disposal",
    explicitFault?: RequestDeadlineSchedulerFault,
  ): void {
    if (this.stopValue !== undefined) return;
    const fault = typeof causeOrFault === "string" ? explicitFault : causeOrFault;
    const cause =
      typeof causeOrFault === "string"
        ? causeOrFault
        : causeOrFault.code === "ownership_lost"
          ? "ownership_lost"
          : causeOrFault.code === "storage_failure"
            ? "storage_failure"
            : "contract_fault";
    const state = Object.freeze({
      cause,
      reason,
      recoverable: cause === "ownership_lost",
      diagnostic: stopDiagnostics[cause],
    });
    this.stopValue = state;
    this.faultValue = fault;
    for (const observer of [...this.stopObservers]) {
      try {
        observer(state);
      } catch {}
    }
    this.scheduler.stop();
    this.runtime.stop(reason);
  }
}

export function markCommunicatorLifecycleReady(
  lifecycle: CommunicatorStartupRecoveryLifecycle,
): void {
  lifecycle.markReady(readyAuthority);
}
