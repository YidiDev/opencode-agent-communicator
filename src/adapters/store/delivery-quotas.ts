import type {
  DeliveryStoreFailureCode,
  PrepareDeliveryInput,
} from "../../application/delivery-ports";
import type { StoreContext } from "./store-types";
import { StoreIntegrityError } from "./store-types";

interface AggregateRow {
  readonly value: number;
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

function exceedsCountQuotas(context: StoreContext, input: PrepareDeliveryInput): boolean {
  const dimensions = [
    [
      "SELECT count(*) AS value FROM deliveries WHERE workspace_key = ?",
      [input.workspaceKey],
      context.limits.deliveryRecordsPerWorkspace,
    ],
    [
      "SELECT count(*) AS value FROM deliveries WHERE workspace_key = ? AND source_session_id = ?",
      [input.workspaceKey, input.sourceSessionId],
      context.limits.deliveryRecordsPerSource,
    ],
    [
      "SELECT count(*) AS value FROM deliveries WHERE workspace_key = ? AND target_session_id = ?",
      [input.workspaceKey, input.targetSessionId],
      context.limits.deliveryRecordsPerTarget,
    ],
  ] as const;
  return dimensions.some(([sql, values, maximum]) => aggregate(context, sql, values) >= maximum);
}

function exceedsEnvelopeQuotas(
  context: StoreContext,
  input: PrepareDeliveryInput,
  envelopeBytes: number,
): boolean {
  const dimensions = [
    [
      `SELECT COALESCE(sum(length(CAST(prepared_envelope AS BLOB))), 0) AS value
       FROM deliveries WHERE workspace_key = ? AND state = 'prepared'`,
      [input.workspaceKey],
      context.limits.retainedEnvelopeBytesPerWorkspace,
    ],
    [
      `SELECT COALESCE(sum(length(CAST(prepared_envelope AS BLOB))), 0) AS value
       FROM deliveries WHERE workspace_key = ? AND source_session_id = ? AND state = 'prepared'`,
      [input.workspaceKey, input.sourceSessionId],
      context.limits.retainedEnvelopeBytesPerSource,
    ],
    [
      `SELECT COALESCE(sum(length(CAST(prepared_envelope AS BLOB))), 0) AS value
       FROM deliveries WHERE workspace_key = ? AND target_session_id = ? AND state = 'prepared'`,
      [input.workspaceKey, input.targetSessionId],
      context.limits.retainedEnvelopeBytesPerTarget,
    ],
  ] as const;
  return dimensions.some(
    ([sql, values, maximum]) => aggregate(context, sql, values) + envelopeBytes > maximum,
  );
}

function exceedsRates(context: StoreContext, input: PrepareDeliveryInput, since: number): boolean {
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
  input: PrepareDeliveryInput,
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
