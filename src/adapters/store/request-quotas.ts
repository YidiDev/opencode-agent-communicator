import type { PrepareRequestInput, RequestStoreFailureCode } from "../../application/request-ports";
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
    throw new StoreIntegrityError("A request quota aggregate was malformed.");
  }
  return row.value;
}

export function checkRequestCreateQuotas(
  context: StoreContext,
  input: PrepareRequestInput,
  retainedContentBytes: number,
  rateNowMs: number,
): Extract<RequestStoreFailureCode, "quota_exceeded" | "rate_limited"> | undefined {
  const request = input.request;
  const countDimensions = [
    ["", [], context.limits.pendingRequestsPerWorkspace, "requests_pending_workspace_quota"],
    [
      "AND source_session_id = ?",
      [request.sourceSessionId],
      context.limits.pendingRequestsPerSource,
      "requests_pending_source_quota",
    ],
    [
      "AND target_session_id = ?",
      [request.targetSessionId],
      context.limits.pendingRequestsPerTarget,
      "requests_pending_target_quota",
    ],
  ] as const;
  const byteLimits = [
    context.limits.pendingRequestBytesPerWorkspace,
    context.limits.pendingRequestBytesPerSource,
    context.limits.pendingRequestBytesPerTarget,
  ];
  for (const [index, [filter, values, maximum, quotaIndex]] of countDimensions.entries()) {
    const parameters = [request.workspaceKey, ...values];
    const where = `workspace_key = ? AND resolution_state = 'pending' ${filter}`;
    if (
      aggregate(
        context,
        `SELECT count(*) AS value FROM requests INDEXED BY ${quotaIndex} WHERE ${where}`,
        parameters,
      ) >= maximum
    ) {
      return "quota_exceeded";
    }
    const used = aggregate(
      context,
      `SELECT COALESCE(sum(retained_content_byte_length), 0) AS value
       FROM requests INDEXED BY ${quotaIndex} WHERE ${where}`,
      parameters,
    );
    if (used + retainedContentBytes > (byteLimits[index] ?? 0)) return "quota_exceeded";
  }
  const since = Math.max(0, rateNowMs - context.limits.rateWindowMs);
  context.database.run(
    `DELETE FROM request_rate_events WHERE sequence IN (
       SELECT sequence FROM request_rate_events WHERE workspace_key = ? AND occurred_at_ms <= ?
       ORDER BY occurred_at_ms, sequence LIMIT 100
     )`,
    [request.workspaceKey, since],
  );
  const rates = [
    ["", [], context.limits.requestsPerWorkspaceWindow],
    [
      "AND source_session_id = ?",
      [request.sourceSessionId],
      context.limits.requestsPerSourceWindow,
    ],
    [
      "AND target_session_id = ?",
      [request.targetSessionId],
      context.limits.requestsPerTargetWindow,
    ],
  ] as const;
  for (const [filter, values, maximum] of rates) {
    const count = aggregate(
      context,
      `SELECT count(*) AS value FROM request_rate_events
       WHERE workspace_key = ? AND occurred_at_ms > ? ${filter}`,
      [request.workspaceKey, since, ...values],
    );
    if (count >= maximum) return "rate_limited";
  }
  return undefined;
}

export type RequestCycleCheck = "clear" | "cycle" | "budget_exhausted";

export function checkRequestCycle(
  context: StoreContext,
  input: PrepareRequestInput,
): RequestCycleCheck {
  const request = input.request;
  if (request.sourceSessionId === request.targetSessionId) return "cycle";
  // LIMIT bounds rows admitted to SQLite's recursive work table. It is not a VM-step cap; indexed
  // edge scans are separately bounded by the immutable 1,024 pending-request workspace ceiling.
  const rows = context.database
    .query<{ readonly node: unknown }, [string, string, number]>(
      `WITH RECURSIVE reachable(node) AS (
         VALUES (?)
         UNION
         SELECT edge.target_session_id
         FROM reachable JOIN request_wait_edges AS edge INDEXED BY request_edges_source
           ON edge.workspace_key = ? AND edge.source_session_id = reachable.node
         LIMIT ?
       )
       SELECT node FROM reachable`,
    )
    .all(request.targetSessionId, request.workspaceKey, context.limits.requestTraversalNodes + 1);
  for (const row of rows) {
    if (typeof row.node !== "string") {
      throw new StoreIntegrityError("The request deadlock query returned malformed data.");
    }
    if (row.node === request.sourceSessionId) return "cycle";
  }
  return rows.length > context.limits.requestTraversalNodes ? "budget_exhausted" : "clear";
}
