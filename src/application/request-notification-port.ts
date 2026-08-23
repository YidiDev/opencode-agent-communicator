import type { RequestId } from "../domain/generated-ids";
import type {
  RequestKind,
  RequestResolutionState,
  RetainedRequestResult,
} from "../domain/request-types";

export interface CommittedRequestTerminalEvent {
  readonly requestId: RequestId;
  readonly kind: RequestKind;
  readonly resolutionState: Exclude<RequestResolutionState, "pending">;
  readonly resolvedAtMs: number;
  readonly retainedResult?: RetainedRequestResult;
}

/**
 * Best-effort process-local acceleration after an authoritative terminal state is observed.
 * The immutable event deliberately excludes persistence and participant metadata. The durable
 * request store remains truth. Implementations must return exactly undefined, synchronously.
 */
export interface CommittedRequestNotificationPort {
  notifyTerminal(event: CommittedRequestTerminalEvent): undefined;
}

export const noopCommittedRequestNotifications: CommittedRequestNotificationPort = {
  notifyTerminal: () => undefined,
};
