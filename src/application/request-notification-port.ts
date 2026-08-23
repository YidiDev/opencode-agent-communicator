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
 * request store remains truth, so blocking workflows re-read it after every reconcile wake.
 * Participant list/get integration remains a follow-up: ask/wait exposure must first wire every
 * participant-induced terminal commit to this port. Implementations return exactly undefined.
 */
export interface CommittedRequestNotificationPort {
  notifyTerminal(event: CommittedRequestTerminalEvent): undefined;
}

export const noopCommittedRequestNotifications: CommittedRequestNotificationPort = {
  notifyTerminal: () => undefined,
};
