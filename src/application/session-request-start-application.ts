import type { PendingRequestPayload, RequestMetadata } from "../domain/request-types";
import type { StartOperation } from "../domain/session-start";
import type { RequestDeadlineWakePort } from "./blocking-session-request-boundaries";
import type { RequestAuthorizationPort } from "./request-authorization-port";
import type { RequestAdmissionPersistencePort } from "./request-ports";
import type { SessionStartArguments, SessionStartPorts } from "./session-start-application";
import type { SessionRequestStartPersistencePort } from "./session-start-ports";

export interface SessionRequestStartArguments extends SessionStartArguments {
  readonly initial_message: string;
  readonly request: PendingRequestPayload;
}

export interface SessionRequestStartPorts extends SessionStartPorts {
  readonly requests: RequestAdmissionPersistencePort;
  readonly requestStarts: SessionRequestStartPersistencePort;
  readonly requestAuthorization: RequestAuthorizationPort;
  readonly scheduler: RequestDeadlineWakePort;
}

export interface SessionRequestStartResult {
  readonly operation: StartOperation;
  readonly request: RequestMetadata;
}
