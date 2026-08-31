import { isCoherentRequestMetadata } from "../../domain/request-metadata";
import type { RequestMetadata } from "../../domain/request-types";
import { StoreIntegrityError } from "./store-types";

export interface RequestRow {
  readonly id: unknown;
  readonly workspaceKey: unknown;
  readonly sourceSessionId: unknown;
  readonly targetSessionId: unknown;
  readonly nativeMessageId: unknown;
  readonly deliveryMode?: unknown;
  readonly deliveryTransport?: unknown;
  readonly contextState?: unknown;
  readonly contextAwaitingAtMs?: unknown;
  readonly contextAdmittedAtMs?: unknown;
  readonly contextFailedAtMs?: unknown;
  readonly contextCancelledAtMs?: unknown;
  readonly contextUpdatedAtMs?: unknown;
  readonly linkedStartOperationId?: unknown;
  readonly kind: unknown;
  readonly resolutionState: unknown;
  readonly deliveryState: unknown;
  readonly resultState: unknown;
  readonly payloadByteLength: unknown;
  readonly payloadSha256: unknown;
  readonly createdAtMs: unknown;
  readonly updatedAtMs: unknown;
  readonly deadlineAtMs: unknown;
  readonly submittedAtMs: unknown;
  readonly deliveryUnknownAtMs: unknown;
  readonly admittedAtMs: unknown;
  readonly promotedAtMs: unknown;
  readonly deliveryFailedAtMs: unknown;
  readonly admittedSeq: unknown;
  readonly promotedSeq: unknown;
  readonly evidenceObservedAtMs: unknown;
  readonly resolvedAtMs: unknown;
  readonly resultByteLength: unknown;
  readonly resultSha256: unknown;
  readonly resultAvailableAtMs: unknown;
  readonly resultExpiresAtMs: unknown;
  readonly resultExpiredAtMs: unknown;
  readonly acknowledgedAtMs: unknown;
}

export const requestMetadataColumns = `
id, workspace_key AS workspaceKey, source_session_id AS sourceSessionId,
target_session_id AS targetSessionId, native_message_id AS nativeMessageId, kind,
delivery_mode AS deliveryMode, linked_start_operation_id AS linkedStartOperationId,
delivery_transport AS deliveryTransport,
(SELECT state FROM context_admissions WHERE id = requests.id) AS contextState,
(SELECT awaiting_context_at_ms FROM context_admissions WHERE id = requests.id) AS contextAwaitingAtMs,
(SELECT context_admitted_at_ms FROM context_admissions WHERE id = requests.id) AS contextAdmittedAtMs,
(SELECT failed_at_ms FROM context_admissions WHERE id = requests.id) AS contextFailedAtMs,
(SELECT cancelled_at_ms FROM context_admissions WHERE id = requests.id) AS contextCancelledAtMs,
(SELECT updated_at_ms FROM context_admissions WHERE id = requests.id) AS contextUpdatedAtMs,
resolution_state AS resolutionState, delivery_state AS deliveryState, result_state AS resultState,
payload_byte_length AS payloadByteLength, payload_sha256 AS payloadSha256,
created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs, deadline_at_ms AS deadlineAtMs,
submitted_at_ms AS submittedAtMs, delivery_unknown_at_ms AS deliveryUnknownAtMs,
admitted_at_ms AS admittedAtMs, promoted_at_ms AS promotedAtMs,
delivery_failed_at_ms AS deliveryFailedAtMs, admitted_seq AS admittedSeq,
promoted_seq AS promotedSeq, evidence_observed_at_ms AS evidenceObservedAtMs,
resolved_at_ms AS resolvedAtMs, result_byte_length AS resultByteLength,
result_sha256 AS resultSha256, result_available_at_ms AS resultAvailableAtMs,
result_expires_at_ms AS resultExpiresAtMs, result_expired_at_ms AS resultExpiredAtMs,
acknowledged_at_ms AS acknowledgedAtMs`;

const optionalMappings = [
  ["payloadSha256", "payloadSha256"],
  ["submittedAtMs", "submittedAtMs"],
  ["deliveryUnknownAtMs", "deliveryUnknownAtMs"],
  ["admittedAtMs", "admittedAtMs"],
  ["promotedAtMs", "promotedAtMs"],
  ["deliveryFailedAtMs", "deliveryFailedAtMs"],
  ["resolvedAtMs", "resolvedAtMs"],
  ["resultByteLength", "resultByteLength"],
  ["resultSha256", "resultSha256"],
  ["resultAvailableAtMs", "resultAvailableAtMs"],
  ["resultExpiresAtMs", "resultExpiresAtMs"],
  ["resultExpiredAtMs", "resultExpiredAtMs"],
  ["acknowledgedAtMs", "acknowledgedAtMs"],
] as const;

const contextCommonOptionalMappings = [
  ["payloadSha256", "payloadSha256"],
  ["resolvedAtMs", "resolvedAtMs"],
  ["resultByteLength", "resultByteLength"],
  ["resultSha256", "resultSha256"],
  ["resultAvailableAtMs", "resultAvailableAtMs"],
  ["resultExpiresAtMs", "resultExpiresAtMs"],
  ["resultExpiredAtMs", "resultExpiredAtMs"],
  ["acknowledgedAtMs", "acknowledgedAtMs"],
] as const;

function invalidRow(): StoreIntegrityError {
  return new StoreIntegrityError("Stored request metadata failed strict domain validation.");
}

function projectedDeliveryState(row: RequestRow, contextDelivery: boolean): unknown {
  let deliveryState = row.deliveryState;
  if (contextDelivery) {
    if (row.contextState === "awaiting_context") deliveryState = "awaiting_context";
    else if (row.contextState === "context_admitted") deliveryState = "context_admitted";
    else if (row.contextState === "failed") deliveryState = "delivery_failed";
    else if (row.contextState === "cancelled") deliveryState = "delivery_failed";
    else if (row.contextState !== "prepared") throw invalidRow();
  } else if (row.contextState !== null && row.contextState !== undefined) {
    throw invalidRow();
  }
  return deliveryState;
}

function baseCandidate(
  row: RequestRow,
  contextDelivery: boolean,
  deliveryState: unknown,
): Record<string, unknown> {
  return {
    id: row.id,
    workspaceKey: row.workspaceKey,
    sourceSessionId: row.sourceSessionId,
    targetSessionId: row.targetSessionId,
    nativeMessageId: row.nativeMessageId,
    deliveryMode: contextDelivery ? "context" : (row.deliveryMode ?? "steer"),
    kind: row.kind,
    resolutionState: row.resolutionState,
    deliveryState,
    resultState: row.resultState,
    payloadByteLength: row.payloadByteLength,
    createdAtMs: row.createdAtMs,
    updatedAtMs:
      contextDelivery && typeof row.contextUpdatedAtMs === "number"
        ? Math.max(row.updatedAtMs as number, row.contextUpdatedAtMs)
        : row.updatedAtMs,
    deadlineAtMs: row.deadlineAtMs,
  };
}

function addDeliveryFields(
  candidate: Record<string, unknown>,
  row: RequestRow,
  contextDelivery: boolean,
): void {
  if (row.linkedStartOperationId !== null && row.linkedStartOperationId !== undefined)
    candidate.linkedStartOperationId = row.linkedStartOperationId;
  if (contextDelivery) {
    addContextDeliveryFields(candidate, row);
    return;
  }
  addNativeDeliveryFields(candidate, row);
}

function addContextDeliveryFields(candidate: Record<string, unknown>, row: RequestRow): void {
  for (const [property, rowProperty] of contextCommonOptionalMappings) {
    if (row[rowProperty] !== null) candidate[property] = row[rowProperty];
  }
  if (row.contextAwaitingAtMs !== null) candidate.awaitingContextAtMs = row.contextAwaitingAtMs;
  if (row.contextAdmittedAtMs !== null) candidate.contextAdmittedAtMs = row.contextAdmittedAtMs;
  if (row.contextFailedAtMs !== null) candidate.deliveryFailedAtMs = row.contextFailedAtMs;
  if (row.contextCancelledAtMs !== null) candidate.deliveryFailedAtMs = row.contextCancelledAtMs;
}

function addNativeDeliveryFields(candidate: Record<string, unknown>, row: RequestRow): void {
  for (const [property, rowProperty] of optionalMappings) {
    if (row[rowProperty] !== null) candidate[property] = row[rowProperty];
  }
  if (row.deliveryState === "admitted" || row.deliveryState === "promoted") {
    const evidence: Record<string, unknown> = {
      state: row.deliveryState,
      nativeMessageId: row.nativeMessageId,
      admittedSeq: row.admittedSeq,
      observedAtMs: row.evidenceObservedAtMs,
    };
    if (row.deliveryState === "promoted") evidence.promotedSeq = row.promotedSeq;
    candidate.admissionEvidence = evidence;
  }
}

export function hydrateRequest(row: RequestRow): RequestMetadata {
  const contextDelivery = row.deliveryTransport === "context";
  const candidate = baseCandidate(
    row,
    contextDelivery,
    projectedDeliveryState(row, contextDelivery),
  );
  addDeliveryFields(candidate, row, contextDelivery);
  if (!isCoherentRequestMetadata(candidate)) throw invalidRow();
  return candidate;
}
