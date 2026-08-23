import { validateRequestId } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import {
  validatePendingRequestPayload,
  validateRetainedRequestResult,
} from "../domain/request-content";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CurrentWorkspaceMembershipPort } from "./delivery-ports";
import type { ParticipantRequestGet, RequestParticipantQueryPort } from "./request-ports";

const hiddenFailure = (): DomainResult<never> =>
  domainFailure(
    "not_found_or_unauthorized",
    "Request was not found or the caller is not authorized.",
    false,
  );

function validMetadataView(
  found: Extract<ParticipantRequestGet, { outcome: "metadata" }>,
): boolean {
  const metadata = found.metadata;
  const resolution: string = metadata.resolutionState;
  if (found.view === "source_pending") {
    return (
      metadata.participantRole === "source" &&
      metadata.resolutionState === "pending" &&
      metadata.resultState === "none"
    );
  }
  if (found.view === "target_terminal") {
    return metadata.participantRole === "target" && resolution !== "pending";
  }
  return (
    metadata.participantRole === "source" &&
    resolution !== "pending" &&
    resolution !== "answered" &&
    resolution !== "reached" &&
    metadata.resultState === "none"
  );
}

function validContentView(
  found: Exclude<ParticipantRequestGet, { outcome: "metadata" | "result_expired" }>,
): boolean {
  const metadata = found.metadata;
  if (found.outcome === "pending_payload") {
    return (
      validatePendingRequestPayload(found.payload).ok &&
      metadata.participantRole === "target" &&
      metadata.resolutionState === "pending" &&
      metadata.resultState === "none" &&
      metadata.kind === found.payload.kind
    );
  }
  return (
    validateRetainedRequestResult(found.result).ok &&
    metadata.participantRole === "source" &&
    metadata.resultState === "available" &&
    ((metadata.resolutionState === "answered" && found.result.kind === "ask") ||
      (metadata.resolutionState === "reached" && found.result.kind === "wait"))
  );
}

function validParticipantBinding(
  found: ParticipantRequestGet,
  requestId: string,
  caller: string,
): boolean {
  const metadata = found.metadata;
  if (metadata.requestId !== requestId) return false;
  if (
    metadata.participantRole === "source"
      ? metadata.sourceSessionId !== caller
      : metadata.targetSessionId !== caller
  )
    return false;
  if (found.outcome === "metadata") return validMetadataView(found);
  if (found.outcome === "pending_payload" || found.outcome === "available_result") {
    return validContentView(found);
  }
  return (
    metadata.participantRole === "source" &&
    (metadata.resultState === "expired" || metadata.resultState === "acknowledged") &&
    ((metadata.resolutionState === "answered" && metadata.kind === "ask") ||
      (metadata.resolutionState === "reached" && metadata.kind === "wait"))
  );
}

export async function getSessionRequest(
  ports: {
    readonly membership: CurrentWorkspaceMembershipPort;
    readonly requests: RequestParticipantQueryPort;
  },
  context: {
    readonly workspaceKey: WorkspaceKey;
    readonly callerSessionId: unknown;
    readonly fencingToken: FencingToken;
  },
  args: { readonly request_id: unknown },
): Promise<DomainResult<ParticipantRequestGet>> {
  const caller = validateSessionId(context.callerSessionId);
  if (!caller.ok) return domainFailure("invalid_arguments", caller.message, false);
  const requestId = validateRequestId(args.request_id);
  if (!requestId.ok) return domainFailure("invalid_arguments", requestId.message, false);
  try {
    const membership = await ports.membership.readCurrentRoots(
      context.workspaceKey,
      caller.value,
      caller.value,
    );
    if (!membership.sourceVisible) {
      return domainFailure(
        "caller_not_visible",
        "Caller is not a current visible root session.",
        false,
      );
    }
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) {
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    }
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  try {
    const found = await ports.requests.getParticipantRequest({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId: requestId.value,
      callerSessionId: caller.value,
    });
    if (!found) return hiddenFailure();
    if (!validParticipantBinding(found, requestId.value, caller.value)) {
      throw new Error("The participant request projection was incoherent.");
    }
    if (found.outcome === "result_expired") {
      return domainFailure(
        "result_expired",
        "The retained request result is no longer available.",
        false,
      );
    }
    return { ok: true, value: found };
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) {
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    }
    return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
}
