import type { RequestMetadata } from "../../domain/request-types";
import { eraseRequestPrivateContent, selectRequest } from "./request-repository-shared";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export class RequestExpiryRepository {
  constructor(private readonly context: StoreContext) {}

  expireDueOwned(workspaceKey: string, storeNowMs: number, limit: number): RequestMetadata[] {
    const rows = this.context.database
      .query<RequestRow, [string, number, number]>(
        `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_deadline
         WHERE workspace_key = ? AND resolution_state = 'pending' AND deadline_at_ms <= ?
         ORDER BY deadline_at_ms, id LIMIT ?`,
      )
      .all(workspaceKey, storeNowMs, limit);
    return this.expireRowsOwned(workspaceKey, storeNowMs, rows);
  }

  expireDueForSourceOwned(
    workspaceKey: string,
    sourceSessionId: string,
    storeNowMs: number,
    limit: number,
  ): RequestMetadata[] {
    const rows = this.context.database
      .query<RequestRow, [string, string, number, number]>(
        `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_due_source
         WHERE workspace_key = ? AND source_session_id = ? AND resolution_state = 'pending'
           AND deadline_at_ms <= ? ORDER BY deadline_at_ms, id LIMIT ?`,
      )
      .all(workspaceKey, sourceSessionId, storeNowMs, limit);
    return this.expireRowsOwned(workspaceKey, storeNowMs, rows);
  }

  expireDueForTargetOwned(
    workspaceKey: string,
    targetSessionId: string,
    storeNowMs: number,
    limit: number,
  ): RequestMetadata[] {
    const rows = this.context.database
      .query<RequestRow, [string, string, number, number]>(
        `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_due_target
         WHERE workspace_key = ? AND target_session_id = ? AND resolution_state = 'pending'
           AND deadline_at_ms <= ? ORDER BY deadline_at_ms, id LIMIT ?`,
      )
      .all(workspaceKey, targetSessionId, storeNowMs, limit);
    return this.expireRowsOwned(workspaceKey, storeNowMs, rows);
  }

  expireExactDueOwned(
    workspaceKey: string,
    requestId: string,
    storeNowMs: number,
  ): RequestMetadata | undefined {
    const request = selectRequest(this.context, workspaceKey, requestId);
    if (request?.resolutionState !== "pending" || request.deadlineAtMs > storeNowMs)
      return undefined;
    this.expireOne(request, storeNowMs);
    return selectRequest(this.context, workspaceKey, requestId);
  }

  expireOne(before: RequestMetadata, nowMs: number): void {
    eraseRequestPrivateContent(this.context, before.id);
    const changed = this.context.database.run(
      `UPDATE requests SET resolution_state = 'deadline_expired', resolved_at_ms = ?,
         updated_at_ms = MAX(updated_at_ms, ?), payload_sha256 = NULL,
         retained_content_byte_length = NULL
       WHERE workspace_key = ? AND id = ? AND resolution_state = 'pending' AND deadline_at_ms <= ?`,
      [nowMs, nowMs, before.workspaceKey, before.id, nowMs],
    );
    if (changed.changes !== 1) throw new StoreIntegrityError("The request expiry CAS failed.");
  }

  expireRowsOwned(
    workspaceKey: string,
    storeNowMs: number,
    rows: readonly RequestRow[],
  ): RequestMetadata[] {
    const requests: RequestMetadata[] = [];
    for (const row of rows) {
      const before = hydrateRequest(row);
      this.expireOne(before, storeNowMs);
      const request = selectRequest(this.context, workspaceKey, before.id);
      if (!request) throw new StoreIntegrityError("An expired request was absent.");
      requests.push(request);
    }
    return requests;
  }
}
