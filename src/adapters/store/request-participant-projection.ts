import type {
  ParticipantRequestGet,
  ParticipantRequestMetadata,
} from "../../application/request-ports";
import type { RequestMetadata } from "../../domain/request-types";
import { validateStoredResultState } from "./request-result-validation";
import { hydrateRequest, type RequestRow } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export type RoleRow = RequestRow & { readonly participantRole: unknown };

function constructApprovedProjection<
  Metadata extends RequestMetadata,
  Role extends "source" | "target",
>(request: Metadata, participantRole: Role): ParticipantRequestMetadata<Role, Metadata> {
  const projection = {
    requestId: request.id,
    participantRole,
    kind: request.kind,
    sourceSessionId: request.sourceSessionId,
    targetSessionId: request.targetSessionId,
    resolutionState: request.resolutionState,
    deliveryState: request.deliveryState,
    ...(request.deliveryMode === undefined ? {} : { deliveryMode: request.deliveryMode }),
    ...(request.linkedStartOperationId === undefined
      ? {}
      : { linkedStartOperationId: request.linkedStartOperationId }),
    resultState: request.resultState,
    createdAtMs: request.createdAtMs,
    updatedAtMs: request.updatedAtMs,
    deadlineAtMs: request.deadlineAtMs,
    ...(request.resolvedAtMs === undefined ? {} : { resolvedAtMs: request.resolvedAtMs }),
    ...(request.submittedAtMs === undefined ? {} : { submittedAtMs: request.submittedAtMs }),
    ...(request.deliveryUnknownAtMs === undefined
      ? {}
      : { deliveryUnknownAtMs: request.deliveryUnknownAtMs }),
    ...(request.admittedAtMs === undefined ? {} : { admittedAtMs: request.admittedAtMs }),
    ...(request.promotedAtMs === undefined ? {} : { promotedAtMs: request.promotedAtMs }),
    ...(request.deliveryFailedAtMs === undefined
      ? {}
      : { deliveryFailedAtMs: request.deliveryFailedAtMs }),
    ...(request.resultAvailableAtMs === undefined
      ? {}
      : { resultAvailableAtMs: request.resultAvailableAtMs }),
    ...(request.resultExpiresAtMs === undefined
      ? {}
      : { resultExpiresAtMs: request.resultExpiresAtMs }),
    ...(request.resultExpiredAtMs === undefined
      ? {}
      : { resultExpiredAtMs: request.resultExpiredAtMs }),
    ...(request.acknowledgedAtMs === undefined
      ? {}
      : { acknowledgedAtMs: request.acknowledgedAtMs }),
  };
  return projection as ParticipantRequestMetadata<Role, Metadata>;
}

export function projectParticipant<
  Metadata extends RequestMetadata,
  Role extends "source" | "target",
>(request: Metadata, participantRole: Role): ParticipantRequestMetadata<Role, Metadata> {
  switch (request.resolutionState) {
    case "pending":
    case "answered":
    case "reached":
    case "deadline_expired":
    case "cancelled":
    case "delivery_failed":
    case "target_stopped":
    case "source_stopped":
    case "target_deleted":
    case "source_deleted":
      return constructApprovedProjection(request, participantRole);
    default: {
      const exhaustive: never = request;
      throw new StoreIntegrityError(`Unsupported request state: ${String(exhaustive)}`);
    }
  }
}

export function hydrateParticipantRole(row: RoleRow): ParticipantRequestMetadata {
  if (row.participantRole !== "source" && row.participantRole !== "target") {
    throw new StoreIntegrityError("Stored request participant role was invalid.");
  }
  return projectParticipant(hydrateRequest(row), row.participantRole);
}

export function getSourceTerminalParticipant(
  context: StoreContext,
  request: Exclude<RequestMetadata, { readonly resolutionState: "pending" }>,
): ParticipantRequestGet {
  if (request.resolutionState === "answered" || request.resolutionState === "reached") {
    if (request.resultState !== "available") {
      validateStoredResultState(context, request);
      return { outcome: "result_expired", metadata: projectParticipant(request, "source") };
    }
    const stored = validateStoredResultState(context, request);
    if (!stored) throw new StoreIntegrityError("Stored request result was missing.");
    if (
      request.resolutionState === "answered" &&
      request.kind === "ask" &&
      stored.result.kind === "ask"
    ) {
      return {
        outcome: "available_result",
        metadata: projectParticipant(request, "source"),
        result: stored.result,
      };
    }
    if (
      request.resolutionState === "reached" &&
      request.kind === "wait" &&
      stored.result.kind === "wait"
    ) {
      return {
        outcome: "available_result",
        metadata: projectParticipant(request, "source"),
        result: stored.result,
      };
    }
    throw new StoreIntegrityError("Stored request result correlation was invalid.");
  }
  return {
    outcome: "metadata",
    view: "source_unsuccessful_terminal",
    metadata: projectParticipant(request, "source"),
  };
}
