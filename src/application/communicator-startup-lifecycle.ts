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

const readyAuthority = Symbol("communicator-startup-ready");

export class CommunicatorStartupRecoveryLifecycle implements CommunicatorReadinessPort {
  private reasonValue: RequestRuntimeStopReason | undefined;
  private faultValue: RequestDeadlineSchedulerFault | undefined;
  private readyValue = false;

  constructor(
    readonly fencingToken: FencingToken,
    readonly scheduler: RequestDeadlineScheduler,
    readonly summary: Readonly<CommunicatorStartupRecoverySummary>,
    private readonly runtime: RequestRuntime,
  ) {}

  get stopReason(): RequestRuntimeStopReason | undefined {
    return this.reasonValue;
  }

  get schedulerFault(): RequestDeadlineSchedulerFault | undefined {
    return this.faultValue ?? this.scheduler.fault;
  }

  get status(): "starting" | "ready" | "stopped" {
    if (this.reasonValue !== undefined) return "stopped";
    return this.readyValue ? "ready" : "starting";
  }

  assertReady(): void {
    if (this.status !== "ready") {
      throw new Error("Communicator application lifecycle is not ready for ordinary work.");
    }
  }

  ownershipLost(): void {
    this.stop("ownership_lost");
  }

  markReady(authority: symbol): void {
    if (authority !== readyAuthority) throw new Error("Invalid lifecycle ready authority.");
    if (this.reasonValue === undefined) this.readyValue = true;
  }

  stop(reason: RequestRuntimeStopReason, fault?: RequestDeadlineSchedulerFault): void {
    if (this.reasonValue !== undefined) return;
    this.reasonValue = reason;
    this.faultValue = fault;
    this.scheduler.stop();
    this.runtime.stop(reason);
  }
}

export function markCommunicatorLifecycleReady(
  lifecycle: CommunicatorStartupRecoveryLifecycle,
): void {
  lifecycle.markReady(readyAuthority);
}
