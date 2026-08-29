import type { WorkspaceKey } from "../domain/workspaces";
import type { AdvisoryLockPersistencePort } from "./advisory-lock-ports";
import type {
  ClockPort,
  CurrentWorkspaceMembershipPort,
  DeliveryPersistencePort,
  NativeQueueAdmissionPort,
  OwnershipPort,
  RecoveryStartupBarrierPort,
} from "./delivery-ports";
import type { DeliveryRetentionPersistencePort } from "./delivery-retention";
import type {
  NativeParticipantPresencePort,
  ParticipantDeletionPersistencePort,
} from "./participant-deletion-ports";
import type { RequestDeadlineTimerPort } from "./request-deadline-scheduler";
import type {
  NativeSteerAdmissionPort,
  RequestAdmissionPersistencePort,
  RequestDeadlinePersistencePort,
  RequestParticipantActivityPort,
  RequestRecoveryPersistencePort,
  RequestResultRetentionPersistencePort,
  RequestRetentionPersistencePort,
} from "./request-ports";
import type { RequestRuntime } from "./request-runtime";
import type {
  NativeSessionStartPort,
  StartLimits,
  StartOperationPersistencePort,
} from "./session-start-ports";
import type { StartupDeadlineTimerPort } from "./startup-effect-control";

export interface CommunicatorStartupRecoveryPorts {
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly deliveries: DeliveryPersistencePort & DeliveryRetentionPersistencePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly requests: RequestRecoveryPersistencePort &
    RequestAdmissionPersistencePort &
    RequestDeadlinePersistencePort &
    ParticipantDeletionPersistencePort;
  readonly locks?: AdvisoryLockPersistencePort;
  readonly participantPresence: NativeParticipantPresencePort;
  readonly activity: RequestParticipantActivityPort;
  readonly nativeSteer: NativeSteerAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly startupBarrier: RecoveryStartupBarrierPort;
  readonly clock: ClockPort;
  readonly runtime: RequestRuntime;
  readonly resultRetention: RequestResultRetentionPersistencePort;
  readonly requestRetention: RequestRetentionPersistencePort;
  readonly starts: StartOperationPersistencePort;
  readonly nativeStart: NativeSessionStartPort;
  readonly startLimits?: StartLimits;
}

export interface CommunicatorStartupRecoveryInput {
  readonly workspaceKey: WorkspaceKey;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
  readonly limit: number;
  readonly timers?: RequestDeadlineTimerPort;
  readonly startupTimers?: StartupDeadlineTimerPort;
  readonly nowMonotonicMs?: () => number;
}
