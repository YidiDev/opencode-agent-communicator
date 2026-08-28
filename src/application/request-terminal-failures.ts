import type { RequestId } from "../domain/generated-ids";
import { OwnershipLostFault } from "../domain/ownership";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { RequestStoreFailureCode } from "./request-ports";

export function requestMutationStoreFailure(code: RequestStoreFailureCode): DomainResult<never> {
  switch (code) {
    case "quota_exceeded":
      return domainFailure("quota_exceeded", "Request result quota is exhausted.", false);
    case "rate_limited":
      return domainFailure("rate_limited", "Request mutation rate is limited.", true);
    case "ownership_lost":
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    case "state_conflict":
      return domainFailure("state_conflict", "Request state does not allow this operation.", false);
    case "storage_unavailable":
    case "deadlock_detected":
      return malformedRequestStoreFailure();
  }
}

export function malformedRequestStoreFailure(): DomainResult<never> {
  return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
}

export function hiddenRequestFailure(): DomainResult<never> {
  return domainFailure(
    "not_found_or_unauthorized",
    "Request was not found or the caller is not authorized.",
    false,
  );
}

export function terminalRequestFailure(request: RequestMetadata): DomainResult<never> {
  const state = request.resolutionState;
  if (state === "pending") {
    return domainFailure("state_conflict", "Request kind does not allow this operation.", false);
  }
  if (state === "answered" || state === "reached") {
    return domainFailure("request_not_pending", "Request is already resolved.", false, {
      terminal_state: state,
    });
  }
  const messages = {
    cancelled: "Request was cancelled.",
    deadline_expired: "Request deadline expired.",
    delivery_failed: "Request delivery failed.",
    target_stopped: "Request target was stopped.",
    source_stopped: "Request source was stopped.",
    target_deleted: "Request target was deleted.",
    source_deleted: "Request source was deleted.",
  } as const;
  const code = state === "cancelled" ? "request_cancelled" : state;
  return domainFailure(code, messages[state], false);
}

export function requestMatchesParticipant(
  request: RequestMetadata,
  workspaceKey: WorkspaceKey,
  requestId: RequestId,
  callerSessionId: SessionId,
  role: "source" | "target",
): boolean {
  return (
    request.workspaceKey === workspaceKey &&
    request.id === requestId &&
    (role === "source"
      ? request.sourceSessionId === callerSessionId
      : request.targetSessionId === callerSessionId)
  );
}

export function thrownRequestStoreFailure(cause: unknown): DomainResult<never> {
  return cause instanceof OwnershipLostFault
    ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
    : malformedRequestStoreFailure();
}
