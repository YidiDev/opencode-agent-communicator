import { OwnershipLostFault } from "../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../domain/request-identity";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { runUntilAborted } from "./abortable-operation";
import { admitClaimedSessionRequest } from "./admit-claimed-session-request";
import type {
  RequestParticipantActivityObservation,
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "./request-ports";
import {
  inspectParticipantObservation,
  inspectRequestMetadata,
} from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import {
  rejectedRequestRecoveryFailure,
  requestRecoveryFailure,
  sessionRequestRecoveryControlStopped,
  validRequestStoreFailure,
} from "./session-request-recovery-support";
import { snapshotDataRecord } from "./strict-port-boundaries";

export type PreparedRecoveryDecision = "submitted" | "skipped" | "terminalized";

function inspectClaim(
  value: unknown,
  original: RequestMetadata,
): DomainResult<Readonly<{ readonly request: RequestMetadata; readonly envelope?: string }>> {
  const claim = snapshotDataRecord(value, 30);
  if (!claim) return requestRecoveryFailure("storage_unavailable");
  const keys = Object.keys(claim);
  if (claim.ok === false) {
    return keys.length === 2 && keys.includes("code") && validRequestStoreFailure(claim.code)
      ? requestRecoveryFailure(claim.code)
      : requestRecoveryFailure("storage_unavailable");
  }
  const request = inspectRequestMetadata(claim.request);
  if (
    claim.ok !== true ||
    !keys.includes("request") ||
    (keys.length !== 2 && keys.length !== 3) ||
    (keys.length === 3 && !keys.includes("envelopeJson")) ||
    !request ||
    !isCoherentRequestMetadata(request) ||
    !hasRequestIdentity(snapshotRequestIdentity(original), request)
  ) {
    return requestRecoveryFailure("storage_unavailable");
  }
  if (claim.envelopeJson !== undefined && typeof claim.envelopeJson !== "string") {
    return requestRecoveryFailure("storage_unavailable");
  }
  return {
    ok: true,
    value: Object.freeze({
      request,
      ...(typeof claim.envelopeJson === "string" ? { envelope: claim.envelopeJson } : {}),
    }),
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: activity, claim, ownership, and admission failures require distinct externally safe mappings.
export async function recoverOnePreparedSessionRequest(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
  request: RequestMetadata,
): Promise<DomainResult<PreparedRecoveryDecision>> {
  if (input.effectSignal.aborted || sessionRequestRecoveryControlStopped(ports, input)) {
    return requestRecoveryFailure("ownership_lost");
  }
  let promise: Promise<RequestParticipantActivityObservation>;
  try {
    promise = ports.activity.observeRequestParticipants(
      input.workspaceKey,
      request.sourceSessionId,
      request.targetSessionId,
      input.effectSignal,
    );
  } catch {
    return domainFailure("native_unavailable", "Current request activity is unavailable.", true);
  }
  const settlement = await runUntilAborted(input.effectSignal, () => promise);
  if (settlement.kind === "aborted") return requestRecoveryFailure("ownership_lost");
  if (settlement.kind === "rejected") {
    if (settlement.cause instanceof OwnershipLostFault) {
      return requestRecoveryFailure("ownership_lost");
    }
    return domainFailure("native_unavailable", "Current request activity is unavailable.", true);
  }
  const observed: unknown = settlement.value;
  const activity = inspectParticipantObservation(observed);
  if (!activity) {
    return domainFailure("native_unavailable", "Current request activity is malformed.", true);
  }
  if (sessionRequestRecoveryControlStopped(ports, input)) {
    return requestRecoveryFailure("ownership_lost");
  }
  if (
    !activity.sourceVisible ||
    !activity.targetVisible ||
    ((request.deliveryMode ?? "steer") === "steer" &&
      activity.targetStatus !== "busy" &&
      activity.targetStatus !== "retry") ||
    request.deliveryMode === "initial"
  ) {
    return { ok: true, value: "skipped" };
  }
  let claimed: unknown;
  try {
    const settlement = await runUntilAborted(input.effectSignal, () =>
      ports.requests.claimPrepared({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        requestId: request.id,
      }),
    );
    if (settlement.kind === "aborted") return requestRecoveryFailure("ownership_lost");
    if (settlement.kind === "rejected") {
      return rejectedRequestRecoveryFailure(
        settlement.cause,
        "Request claim storage is unavailable.",
      );
    }
    claimed = settlement.value;
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) return requestRecoveryFailure("ownership_lost");
    return domainFailure("storage_unavailable", "Request claim storage is unavailable.", true);
  }
  const claim = inspectClaim(claimed, request);
  if (!claim.ok) return claim;
  if (claim.value.request.deliveryState !== "submitting" || claim.value.envelope === undefined) {
    if (claim.value.request.resolutionState === "pending") {
      return { ok: true, value: "skipped" };
    }
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(claim.value.request));
    return { ok: true, value: "terminalized" };
  }
  const admission = await admitClaimedSessionRequest(ports, {
    workspaceKey: input.workspaceKey,
    fencingToken: input.fencingToken,
    request: claim.value.request,
    envelope: claim.value.envelope,
    control: input,
    effectSignal: input.effectSignal,
  });
  return admission.ok ? { ok: true, value: "submitted" } : admission;
}
