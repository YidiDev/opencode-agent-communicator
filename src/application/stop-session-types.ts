import type { Sha256DigestPort } from "../domain/message-payload";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorReadinessPort } from "./communicator-readiness-port";
import type { OwnershipPort } from "./delivery-ports";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type { RequestParticipantActivityPort } from "./request-ports";
import type {
  NativeSessionInterruptPort,
  SessionStopApprovalPort,
  SessionStopPersistencePort,
} from "./session-stop-ports";

export interface SessionStopArguments {
  readonly session_id: unknown;
  readonly reason?: unknown;
}

export interface SessionStopContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly abort: AbortSignal;
  readonly deadlineMs?: number;
}

export interface SessionStopPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly activity: RequestParticipantActivityPort;
  readonly approval: SessionStopApprovalPort;
  readonly requests: SessionStopPersistencePort;
  readonly nativeInterrupt: NativeSessionInterruptPort;
  readonly ownership: OwnershipPort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly digest: Sha256DigestPort;
}

export interface SessionStopResult {
  readonly sessionId: SessionId;
  readonly communicatorState: {
    readonly outcome: "applied";
    readonly requestsTerminalized: number;
    readonly targetStopped: number;
    readonly sourceStopped: number;
  };
  readonly nativeOutcome: "already_idle" | "interrupted";
}
