import type { PendingRequestMetadata } from "../../domain/request-types";
import { type StoreContext, StoreIntegrityError } from "./store-types";

interface ResultQuotaTotal {
  readonly count: number;
  readonly bytes: number;
}

function assertTotal(row: ResultQuotaTotal | null): ResultQuotaTotal {
  if (!row || !Number.isSafeInteger(row.count) || !Number.isSafeInteger(row.bytes)) {
    throw new StoreIntegrityError("Stored result quota totals were malformed.");
  }
  return row;
}

/** Each bounded aggregate is index-only and has the exact predicate prefix for its dimension. */
export function availableResultQuotaAllows(
  context: StoreContext,
  request: PendingRequestMetadata,
  candidateBytes: number,
): boolean {
  const source = assertTotal(
    context.database
      .query<ResultQuotaTotal, [string, string]>(
        `SELECT count(*) AS count, COALESCE(sum(result_byte_length), 0) AS bytes
         FROM requests INDEXED BY requests_available_source_quota
         WHERE workspace_key = ? AND source_session_id = ? AND result_state = 'available'`,
      )
      .get(request.workspaceKey, request.sourceSessionId),
  );
  const target = assertTotal(
    context.database
      .query<ResultQuotaTotal, [string, string]>(
        `SELECT count(*) AS count, COALESCE(sum(result_byte_length), 0) AS bytes
         FROM requests INDEXED BY requests_available_target_quota
         WHERE workspace_key = ? AND target_session_id = ? AND result_state = 'available'`,
      )
      .get(request.workspaceKey, request.targetSessionId),
  );
  const workspace = assertTotal(
    context.database
      .query<ResultQuotaTotal, [string]>(
        `SELECT count(*) AS count, COALESCE(sum(result_byte_length), 0) AS bytes
         FROM requests INDEXED BY requests_available_workspace_quota
         WHERE workspace_key = ? AND result_state = 'available'`,
      )
      .get(request.workspaceKey),
  );
  return (
    source.count + 1 <= context.limits.availableResultsPerSource &&
    target.count + 1 <= context.limits.availableResultsPerTarget &&
    workspace.count + 1 <= context.limits.availableResultsPerWorkspace &&
    source.bytes + candidateBytes <= context.limits.retainedResultBytesPerSource &&
    target.bytes + candidateBytes <= context.limits.retainedResultBytesPerTarget &&
    workspace.bytes + candidateBytes <= context.limits.retainedResultBytesPerWorkspace
  );
}
