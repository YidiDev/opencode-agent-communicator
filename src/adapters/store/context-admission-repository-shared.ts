import { createHash } from "node:crypto";

import type { ContextSnapshotItem } from "../../application/context-admission-ports";
import {
  type ContextAdmissionId,
  type ContextAdmissionMetadata,
  isCoherentContextAdmission,
} from "../../domain/context-admissions";
import type { FencingToken } from "../../domain/ownership";
import { eraseRequestPrivateContent } from "./request-repository-shared";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export interface ContextAdmissionRow {
  readonly id: unknown;
  readonly kind: unknown;
  readonly workspaceKey: unknown;
  readonly sourceSessionId: unknown;
  readonly targetSessionId: unknown;
  readonly state: unknown;
  readonly contentByteLength: unknown;
  readonly contentSha256: unknown;
  readonly createdAtMs: unknown;
  readonly updatedAtMs: unknown;
  readonly awaitingContextAtMs: unknown;
  readonly contextAdmittedAtMs: unknown;
  readonly failedAtMs: unknown;
  readonly cancelledAtMs: unknown;
  readonly claimedFencingToken: unknown;
  readonly payloadJson?: unknown;
}

export const contextColumns = `id, kind, workspace_key AS workspaceKey,
  source_session_id AS sourceSessionId, target_session_id AS targetSessionId, state,
  content_byte_length AS contentByteLength, content_sha256 AS contentSha256,
  created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs,
  awaiting_context_at_ms AS awaitingContextAtMs,
  context_admitted_at_ms AS contextAdmittedAtMs, failed_at_ms AS failedAtMs,
  cancelled_at_ms AS cancelledAtMs, claimed_fencing_token AS claimedFencingToken`;

export function hydrateContextAdmission(row: ContextAdmissionRow): ContextAdmissionMetadata {
  const candidate: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    workspaceKey: row.workspaceKey,
    sourceSessionId: row.sourceSessionId,
    targetSessionId: row.targetSessionId,
    state: row.state,
    contentByteLength: row.contentByteLength,
    contentSha256: row.contentSha256,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
  const optional = [
    ["awaitingContextAtMs", row.awaitingContextAtMs],
    ["contextAdmittedAtMs", row.contextAdmittedAtMs],
    ["failedAtMs", row.failedAtMs],
    ["cancelledAtMs", row.cancelledAtMs],
    ["claimedFencingToken", row.claimedFencingToken],
  ] as const;
  for (const [key, value] of optional) if (value !== null) candidate[key] = value;
  if (!isCoherentContextAdmission(candidate)) {
    throw new StoreIntegrityError("Stored context admission metadata was malformed.");
  }
  return candidate;
}

export function isExactContextEnvelope(
  envelopeJson: unknown,
  byteLength: unknown,
  sha256: unknown,
): boolean {
  if (typeof envelopeJson !== "string" || typeof sha256 !== "string") return false;
  try {
    JSON.parse(envelopeJson);
  } catch {
    return false;
  }
  const bytes = new TextEncoder().encode(envelopeJson);
  return (
    bytes.length === byteLength &&
    bytes.length >= 1 &&
    bytes.length <= 65_536 &&
    createHash("sha256").update(bytes).digest("hex") === sha256
  );
}

export function selectContextAdmission(
  context: StoreContext,
  workspaceKey: string,
  id: ContextAdmissionId,
): ContextAdmissionMetadata | undefined {
  const row = context.database
    .query<ContextAdmissionRow, [string, string]>(
      `SELECT ${contextColumns} FROM context_admissions WHERE workspace_key = ? AND id = ?`,
    )
    .get(workspaceKey, id);
  return row ? hydrateContextAdmission(row) : undefined;
}

export function failContextAdmissionRows(
  context: StoreContext,
  rows: readonly ContextAdmissionRow[],
  workspaceKey: string,
  fencingToken: FencingToken,
  nowMs: number,
): readonly ContextAdmissionMetadata[] {
  const failed: ContextAdmissionMetadata[] = [];
  for (const row of rows) {
    const admission = hydrateContextAdmission(row);
    context.database.run(
      `UPDATE context_admissions SET state = 'failed', payload_json = NULL,
         failed_at_ms = ?, updated_at_ms = ?
       WHERE workspace_key = ? AND id = ? AND state = 'awaiting_context'`,
      [nowMs, nowMs, workspaceKey, admission.id],
    );
    if (admission.kind === "request") {
      eraseRequestPrivateContent(context, admission.id);
      context.database.run(
        `UPDATE requests SET delivery_state = 'delivery_failed', resolution_state = 'delivery_failed',
           submitted_at_ms = ?, delivery_failed_at_ms = ?, resolved_at_ms = ?, updated_at_ms = ?,
           claimed_fencing_token = ?, retained_content_byte_length = NULL, payload_sha256 = NULL
         WHERE workspace_key = ? AND id = ? AND resolution_state = 'pending'`,
        [nowMs, nowMs, nowMs, nowMs, fencingToken, workspaceKey, admission.id],
      );
    }
    const after = selectContextAdmission(context, workspaceKey, admission.id);
    if (after?.state !== "failed") throw new StoreIntegrityError("Context failure was lost.");
    failed.push(after);
  }
  return failed;
}

export function settleParticipantContextRows(
  context: StoreContext,
  rows: readonly ContextAdmissionRow[],
  workspaceKey: string,
  fencingToken: FencingToken,
  nowMs: number,
  terminalIds: ReadonlySet<string>,
): readonly ContextAdmissionMetadata[] {
  const settled: ContextAdmissionMetadata[] = [];
  for (const row of rows) {
    const admission = hydrateContextAdmission(row);
    const state = terminalIds.has(admission.targetSessionId) ? "failed" : "cancelled";
    const timestampColumn = state === "failed" ? "failed_at_ms" : "cancelled_at_ms";
    context.database.run(
      `UPDATE context_admissions SET state = ?, payload_json = NULL,
         ${timestampColumn} = ?, updated_at_ms = ?
       WHERE workspace_key = ? AND id = ? AND state = 'awaiting_context'`,
      [state, nowMs, nowMs, workspaceKey, admission.id],
    );
    if (admission.kind === "request") {
      eraseRequestPrivateContent(context, admission.id);
      context.database.run(
        `UPDATE requests SET delivery_state = 'delivery_failed', resolution_state = ?,
           submitted_at_ms = ?, delivery_failed_at_ms = ?, resolved_at_ms = ?, updated_at_ms = ?,
           claimed_fencing_token = ?, retained_content_byte_length = NULL, payload_sha256 = NULL
         WHERE workspace_key = ? AND id = ? AND resolution_state = 'pending'`,
        [
          state === "failed" ? "delivery_failed" : "cancelled",
          nowMs,
          nowMs,
          nowMs,
          nowMs,
          fencingToken,
          workspaceKey,
          admission.id,
        ],
      );
    }
    const after = selectContextAdmission(context, workspaceKey, admission.id);
    if (after?.state !== state) {
      throw new StoreIntegrityError("Participant context settlement was lost.");
    }
    settled.push(after);
  }
  return Object.freeze(settled);
}

export function snapshotItem(
  admission: ContextAdmissionMetadata,
  envelopeJson: string,
): ContextSnapshotItem {
  return {
    id: admission.id,
    kind: admission.kind,
    sourceSessionId: admission.sourceSessionId,
    envelopeJson,
    contentByteLength: admission.contentByteLength,
    contentSha256: admission.contentSha256 as ContextSnapshotItem["contentSha256"],
  };
}
