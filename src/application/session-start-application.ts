import type { GeneratedIdFactory } from "../domain/generated-ids";
import type { Sha256DigestPort } from "../domain/message-payload";
import type { SessionStartPolicy } from "../domain/session-start-policy";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorReadinessPort } from "./communicator-readiness-port";
import type { ClockPort, CurrentWorkspaceMembershipPort, OwnershipPort } from "./delivery-ports";
import type {
  NativeSessionStartPort,
  SessionStartApprovalPort,
  StartOperationPersistencePort,
} from "./session-start-ports";

export interface SessionStartArguments {
  readonly idempotency_key: unknown;
  readonly initial_message: unknown;
  readonly title?: unknown;
  readonly agent?: unknown;
  readonly model?: unknown;
}

export interface SessionStartContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
}

export interface SessionStartPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly approval: SessionStartApprovalPort;
  readonly starts: StartOperationPersistencePort;
  readonly nativeStart: NativeSessionStartPort;
  readonly ownership: OwnershipPort;
  readonly clock: ClockPort;
  readonly ids: GeneratedIdFactory;
  readonly digest: Sha256DigestPort;
  readonly policy: SessionStartPolicy;
}
