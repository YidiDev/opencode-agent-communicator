import type { GeneratedIdFactory } from "../domain/generated-ids";
import type { Sha256DigestPort } from "../domain/message-payload";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorReadinessPort } from "./communicator-readiness-port";
import type {
  ClockPort,
  CurrentWorkspaceMembershipPort,
  DeliveryPersistencePort,
  MessageAuthorizationPort,
  NativeQueueAdmissionPort,
  OwnershipPort,
} from "./delivery-ports";

export interface SessionSendContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly abort: AbortSignal;
  readonly deadlineMs?: number;
}

export interface SessionSendPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly authorization: MessageAuthorizationPort;
  readonly deliveries: DeliveryPersistencePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly clock: ClockPort;
  readonly ids: GeneratedIdFactory;
  readonly digest: Sha256DigestPort;
}
