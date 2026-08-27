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
import { boundedExternalCall } from "./bounded-external-call";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
} from "./communicator-readiness-port";
import type { CurrentWorkspaceMembershipPort } from "./delivery-ports";
import { inspectParticipantRequestMetadata } from "./participant-request-boundaries";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type { ParticipantRequestGet, RequestParticipantQueryPort } from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

const hiddenFailure = (): DomainResult<never> =>
  domainFailure(
    "not_found_or_unauthorized",
    "Request was not found or the caller is not authorized.",
    false,
  );

export interface SessionRequestGetPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly requests: RequestParticipantQueryPort;
  readonly notifications: CommittedRequestNotificationPort;
}

function validMetadataView(
  found: Extract<ParticipantRequestGet, { outcome: "metadata" }>,
): boolean {
  const metadata = found.metadata;
  if (!inspectParticipantRequestMetadata(metadata)) return false;
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

// biome-ignore-all format: keep strict projection validation inside its bounded query branch.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one strict boundary correlates exact get shape, terminalization relevance, participant identity, and public projection.
export async function getSessionRequest(
  ports: SessionRequestGetPorts,
  context: {
    readonly workspaceKey: WorkspaceKey;
    readonly callerSessionId: unknown;
    readonly fencingToken: FencingToken;
    readonly abort?: AbortSignal;
    readonly deadlineMs?: number;
  },
  args: unknown,
): Promise<DomainResult<ParticipantRequestGet>> {
  assertCommunicatorReady(ports.readiness, context.fencingToken);
  const caller = validateSessionId(context.callerSessionId);
  if (!caller.ok) return domainFailure("invalid_arguments", caller.message, false);
  const data = snapshotDataRecord(args, 1);
  if (!data || Object.keys(data).length !== 1 || !Object.hasOwn(data, "request_id")) {
    return domainFailure(
      "invalid_arguments",
      "Arguments must be an exact request_id data object.",
      false,
    );
  }
  const requestId = validateRequestId(data.request_id);
  if (!requestId.ok) return domainFailure("invalid_arguments", requestId.message, false);
  const invoke = async <Value>(operation: () => Promise<Value>) => {
    if (context.abort && context.deadlineMs !== undefined) {
      return boundedExternalCall(operation, context.abort, context.deadlineMs);
    }
    try {
      return { kind: "value" as const, value: await operation() };
    } catch (cause: unknown) {
      return { kind: "rejected" as const, cause };
    }
  };
  {
    const membershipCall = await invoke(() => ports.membership.readCurrentRoots(
      context.workspaceKey,
      caller.value,
      caller.value,
    ));
    if (membershipCall.kind === "expired") {
      return domainFailure("deadline_expired", "Request query invocation deadline expired.", false);
    }
    if (membershipCall.kind === "rejected") {
      if (membershipCall.cause instanceof OwnershipLostFault) {
        return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
      }
      return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
    }
    const rawMembership = membershipCall.value;
    try {
    const membership = snapshotDataRecord(rawMembership, 3);
    if (
      !membership ||
      Object.keys(membership).length !== 3 ||
      !Object.hasOwn(membership, "sourceTitle") ||
      !Object.hasOwn(membership, "sourceVisible") ||
      !Object.hasOwn(membership, "targetVisible") ||
      (membership.sourceTitle !== undefined && typeof membership.sourceTitle !== "string") ||
      typeof membership.sourceVisible !== "boolean" ||
      typeof membership.targetVisible !== "boolean"
    ) {
      throw new Error("Current membership was malformed.");
    }
    if (!membership.sourceVisible) {
      return domainFailure(
        "caller_not_visible",
        "Caller is not a current visible root session.",
        false,
      );
    }
    } catch {
      return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
    }
  }
  {
    const foundCall = await invoke(() => ports.requests.getParticipantRequest({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId: requestId.value,
      callerSessionId: caller.value,
    }));
    if (foundCall.kind === "expired") {
      return domainFailure("deadline_expired", "Request query invocation deadline expired.", false);
    }
    if (foundCall.kind === "rejected") {
      if (foundCall.cause instanceof OwnershipLostFault) {
        return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
      }
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
    const rawFound = foundCall.value;
    try {
    if (!rawFound) return hiddenFailure();
    const found = snapshotDataRecord(rawFound, 4);
    if (!found || typeof found.outcome !== "string") {
      throw new Error("The participant query result was malformed.");
    }
    const expectedKeys =
      found.outcome === "metadata"
        ? ["outcome", "view", "metadata", "terminalized"]
        : found.outcome === "result_expired"
          ? ["outcome", "metadata", "terminalized"]
          : [
              "outcome",
              "metadata",
              found.outcome === "pending_payload" ? "payload" : "result",
              "terminalized",
            ];
    if (
      Object.keys(found).length !== expectedKeys.length ||
      !expectedKeys.every((key) => Object.hasOwn(found, key))
    )
      throw new Error("The participant query result had an unexpected shape.");
    const terminalized = snapshotDenseArray(found.terminalized, 1_024);
    if (!terminalized) {
      throw new Error("The participant query terminalizations were malformed.");
    }
    for (const raw of terminalized) {
      const request = inspectRequestMetadata(raw);
      if (
        !request ||
        request.resolutionState === "pending" ||
        request.workspaceKey !== context.workspaceKey ||
        (request.sourceSessionId !== caller.value && request.targetSessionId !== caller.value)
      )
        throw new Error("The participant query terminalization was incoherent.");
      notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(request));
    }
    const projection = Object.fromEntries(
      Object.entries(found).filter(([key]) => key !== "terminalized"),
    ) as ParticipantRequestGet;
    if (!validParticipantBinding(projection, requestId.value, caller.value)) {
      throw new Error("The participant request projection was incoherent.");
    }
    if (projection.outcome === "result_expired") {
      return domainFailure(
        "result_expired",
        "The retained request result is no longer available.",
        false,
      );
    }
    return { ok: true, value: projection };
    } catch {
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
  }
}
