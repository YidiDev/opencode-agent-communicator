import type { DeliveryStoreFailureCode } from "../../application/delivery-ports";
import type { SessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import type { StoreContext } from "./store-types";
import { StoreIntegrityError } from "./store-types";

interface AggregateRow {
  readonly value: number;
}

export interface DeliveryQuotaInput {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly nowMs: number;
}

function aggregate(
  context: StoreContext,
  sql: string,
  parameters: readonly (string | number)[],
): number {
  const row = context.database.query<AggregateRow, (string | number)[]>(sql).get(...parameters);
  if (!row || !Number.isSafeInteger(row.value) || row.value < 0) {
    throw new StoreIntegrityError("A SQLite quota aggregate was malformed.");
  }
  return row.value;
}

function exceedsCountQuotas(context: StoreContext, input: DeliveryQuotaInput): boolean {
  const dimensions = [
    [
      `SELECT (SELECT count(*) FROM deliveries WHERE workspace_key = ?) +
        (SELECT count(*) FROM context_admissions WHERE workspace_key = ? AND kind = 'message')
        AS value`,
      [input.workspaceKey, input.workspaceKey],
      context.limits.deliveryRecordsPerWorkspace,
    ],
    [
      `SELECT (SELECT count(*) FROM deliveries WHERE workspace_key = ? AND source_session_id = ?) +
        (SELECT count(*) FROM context_admissions
         WHERE workspace_key = ? AND source_session_id = ? AND kind = 'message') AS value`,
      [input.workspaceKey, input.sourceSessionId, input.workspaceKey, input.sourceSessionId],
      context.limits.deliveryRecordsPerSource,
    ],
    [
      `SELECT (SELECT count(*) FROM deliveries WHERE workspace_key = ? AND target_session_id = ?) +
        (SELECT count(*) FROM context_admissions
         WHERE workspace_key = ? AND target_session_id = ? AND kind = 'message') AS value`,
      [input.workspaceKey, input.targetSessionId, input.workspaceKey, input.targetSessionId],
      context.limits.deliveryRecordsPerTarget,
    ],
  ] as const;
  return dimensions.some(([sql, values, maximum]) => aggregate(context, sql, values) >= maximum);
}

function exceedsEnvelopeQuotas(
  context: StoreContext,
  input: DeliveryQuotaInput,
  envelopeBytes: number,
): boolean {
  const dimensions = [
    [
      `SELECT (SELECT COALESCE(sum(length(CAST(prepared_envelope AS BLOB))), 0)
        FROM deliveries WHERE workspace_key = ? AND state = 'prepared') +
       (SELECT COALESCE(sum(content_byte_length), 0) FROM context_admissions
        WHERE workspace_key = ? AND kind = 'message' AND state = 'awaiting_context') AS value`,
      [input.workspaceKey, input.workspaceKey],
      context.limits.retainedEnvelopeBytesPerWorkspace,
    ],
    [
      `SELECT (SELECT COALESCE(sum(length(CAST(prepared_envelope AS BLOB))), 0)
        FROM deliveries WHERE workspace_key = ? AND source_session_id = ? AND state = 'prepared') +
       (SELECT COALESCE(sum(content_byte_length), 0) FROM context_admissions
        WHERE workspace_key = ? AND source_session_id = ? AND kind = 'message'
          AND state = 'awaiting_context') AS value`,
      [input.workspaceKey, input.sourceSessionId, input.workspaceKey, input.sourceSessionId],
      context.limits.retainedEnvelopeBytesPerSource,
    ],
    [
      `SELECT (SELECT COALESCE(sum(length(CAST(prepared_envelope AS BLOB))), 0)
        FROM deliveries WHERE workspace_key = ? AND target_session_id = ? AND state = 'prepared') +
       (SELECT COALESCE(sum(content_byte_length), 0) FROM context_admissions
        WHERE workspace_key = ? AND target_session_id = ? AND kind = 'message'
          AND state = 'awaiting_context') AS value`,
      [input.workspaceKey, input.targetSessionId, input.workspaceKey, input.targetSessionId],
      context.limits.retainedEnvelopeBytesPerTarget,
    ],
  ] as const;
  return dimensions.some(
    ([sql, values, maximum]) => aggregate(context, sql, values) + envelopeBytes > maximum,
  );
}

function exceedsRates(context: StoreContext, input: DeliveryQuotaInput, since: number): boolean {
  const dimensions = [
    [
      `SELECT count(*) AS value FROM delivery_rate_events
       WHERE workspace_key = ? AND occurred_at_ms > ?`,
      [input.workspaceKey, since],
      context.limits.deliveriesPerWorkspaceWindow,
    ],
    [
      `SELECT count(*) AS value FROM delivery_rate_events
       WHERE workspace_key = ? AND source_session_id = ? AND occurred_at_ms > ?`,
      [input.workspaceKey, input.sourceSessionId, since],
      context.limits.deliveriesPerSourceWindow,
    ],
    [
      `SELECT count(*) AS value FROM delivery_rate_events
       WHERE workspace_key = ? AND target_session_id = ? AND occurred_at_ms > ?`,
      [input.workspaceKey, input.targetSessionId, since],
      context.limits.deliveriesPerTargetWindow,
    ],
  ] as const;
  return dimensions.some(([sql, values, maximum]) => aggregate(context, sql, values) >= maximum);
}

export function checkDeliveryCreateQuotas(
  context: StoreContext,
  input: DeliveryQuotaInput,
  envelopeBytes: number,
): Extract<DeliveryStoreFailureCode, "quota_exceeded" | "rate_limited"> | undefined {
  const since = Math.max(0, input.nowMs - context.limits.rateWindowMs);
  context.database.run(
    `DELETE FROM delivery_rate_events WHERE sequence IN (
       SELECT sequence FROM delivery_rate_events
       WHERE workspace_key = ? AND occurred_at_ms <= ? ORDER BY occurred_at_ms, sequence LIMIT 100
     )`,
    [input.workspaceKey, since],
  );
  if (exceedsCountQuotas(context, input) || exceedsEnvelopeQuotas(context, input, envelopeBytes)) {
    return "quota_exceeded";
  }
  return exceedsRates(context, input, since) ? "rate_limited" : undefined;
}

export function recordDeliveryRateEvent(context: StoreContext, input: DeliveryQuotaInput): void {
  context.database.run(
    `INSERT INTO delivery_rate_events(workspace_key, source_session_id,
       target_session_id, occurred_at_ms) VALUES (?, ?, ?, ?)`,
    [input.workspaceKey, input.sourceSessionId, input.targetSessionId, input.nowMs],
  );
}
