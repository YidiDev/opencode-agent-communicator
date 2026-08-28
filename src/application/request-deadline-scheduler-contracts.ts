import type { FencingToken } from "../domain/ownership";
import type { WorkspaceKey } from "../domain/workspaces";
import type { DeliveryRetentionPersistencePort } from "./delivery-retention";
import type { RequestDeadlinePumpFaultCode } from "./request-deadline-maintenance";
import type { RequestMaintenancePorts } from "./request-maintenance";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type { RequestDeadlinePersistencePort } from "./request-ports";

export interface RequestDeadlineTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export type RequestDeadlineSchedulerFaultCode = RequestDeadlinePumpFaultCode;

export class RequestDeadlineSchedulerFault extends Error {
  override readonly name = "RequestDeadlineSchedulerFault";

  constructor(readonly code: RequestDeadlineSchedulerFaultCode) {
    super(`Request deadline scheduler stopped: ${code}.`);
  }
}

export interface RequestDeadlineSchedulerOptions {
  readonly requests: RequestDeadlinePersistencePort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly timers?: RequestDeadlineTimerPort;
  readonly nowMonotonicMs?: () => number;
  readonly maintenance?: RequestMaintenancePorts;
  readonly additionalMaintenance?: (
    shouldStop: () => boolean,
    abort: AbortSignal,
  ) => Promise<{ readonly ok: boolean; readonly code?: string }>;
  readonly deliveryRetention?: DeliveryRetentionPersistencePort;
  readonly onFault?: (fault: RequestDeadlineSchedulerFault) => undefined;
}

export type RequestDeadlineSchedulerStatus = "idle" | "starting" | "ready" | "stopped" | "faulted";
export type RequestDeadlineSchedulerReadiness =
  | Readonly<{ readonly ok: true }>
  | Readonly<{ readonly ok: false; readonly fault: RequestDeadlineSchedulerFault }>;
