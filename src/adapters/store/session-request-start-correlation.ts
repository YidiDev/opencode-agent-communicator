import type { RequestMetadata } from "../../domain/request-types";
import type { StartOperation } from "../../domain/session-start";
import type { WorkspaceKey } from "../../domain/workspaces";
import {
  hydrateStartOperation,
  type StartOperationRow,
  startOperationColumns,
} from "./start-operation-rows";
import type { StoreContext } from "./store-types";

export function selectStartOperation(
  context: StoreContext,
  workspaceKey: WorkspaceKey,
  operationId: string,
): StartOperation | undefined {
  const row = context.database
    .query<StartOperationRow, [string, string]>(
      `SELECT ${startOperationColumns} FROM start_operations
       WHERE workspace_key = ? AND id = ?`,
    )
    .get(workspaceKey, operationId);
  return row ? hydrateStartOperation(row) : undefined;
}

/** Correlates a terminal linked request without erasing known or ambiguous native provenance. */
export function settleTerminalLinkedStart(
  context: StoreContext,
  operation: StartOperation,
  request: RequestMetadata,
): void {
  context.database.run("DELETE FROM start_operation_payloads WHERE operation_id = ?", [
    operation.id,
  ]);
  if (operation.creationState === "prepared") {
    context.database.run(
      `DELETE FROM managed_sessions WHERE workspace_key = ? AND operation_id = ?
         AND provenance_state = 'reserved'`,
      [operation.workspaceKey, operation.id],
    );
    context.database.run(
      `UPDATE start_operations SET creation_state = 'failed',
         terminal_reason = 'request_terminal',
         title_state = CASE WHEN title_requested = 1 THEN 'payload_unavailable' ELSE 'skipped' END,
         admission_state = 'payload_unavailable',
         claimed_fencing_token = NULL, updated_at_ms = MAX(updated_at_ms, ?)
       WHERE workspace_key = ? AND id = ? AND creation_state = 'prepared'`,
      [request.updatedAtMs, operation.workspaceKey, operation.id],
    );
  } else if (operation.creationState === "created") {
    context.database.run(
      `UPDATE start_operations
       SET title_state = CASE WHEN title_state IN ('not_started','prepared')
             THEN 'payload_unavailable' ELSE title_state END,
           admission_state = CASE WHEN admission_state IN ('not_started','prepared')
             THEN 'payload_unavailable' ELSE admission_state END,
           updated_at_ms = MAX(updated_at_ms, ?)
       WHERE workspace_key = ? AND id = ? AND creation_state = 'created'`,
      [request.updatedAtMs, operation.workspaceKey, operation.id],
    );
  } else if (operation.creationState === "failed") {
    context.database.run(
      `UPDATE start_operations SET terminal_reason = 'request_terminal',
         updated_at_ms = MAX(updated_at_ms, ?)
       WHERE workspace_key = ? AND id = ? AND creation_state = 'failed'
         AND terminal_reason IS NULL`,
      [request.updatedAtMs, operation.workspaceKey, operation.id],
    );
  }
}
