import type { RequestStoreFailureCode } from "../../application/request-ports";
import type { RequestMetadata } from "../../domain/request-types";
import { classifyDeliveryStorageError } from "./delivery-repository";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export function requestStoreNowMs(context: StoreContext): number {
  const nowMs = context.nowWallMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new StoreIntegrityError("The request store clock was malformed.");
  }
  return nowMs;
}

export function selectRequest(
  context: StoreContext,
  workspace: string,
  id: string,
): RequestMetadata | undefined {
  const row = context.database
    .query<RequestRow, [string, string]>(
      `SELECT ${requestMetadataColumns} FROM requests WHERE workspace_key = ? AND id = ?`,
    )
    .get(workspace, id);
  return row ? hydrateRequest(row) : undefined;
}

export function requestPageLimitReached(context: StoreContext): boolean {
  try {
    const pages = context.database
      .query<{ readonly value: number }, []>("SELECT page_count AS value FROM pragma_page_count")
      .get()?.value;
    const free = context.database
      .query<{ readonly value: number }, []>(
        "SELECT freelist_count AS value FROM pragma_freelist_count",
      )
      .get()?.value;
    return pages === context.maximumPageCount && free === 0;
  } catch {
    return false;
  }
}

export function requestFailure(
  cause: unknown,
  atLimit: boolean,
): { readonly ok: false; readonly code: RequestStoreFailureCode } {
  return { ok: false, code: classifyDeliveryStorageError(cause, () => atLimit) };
}

export function eraseRequestPrivateContent(context: StoreContext, requestId: string): void {
  context.database.run("DELETE FROM request_payloads WHERE request_id = ?", [requestId]);
  context.database.run("DELETE FROM request_wait_edges WHERE request_id = ?", [requestId]);
  assertTerminalPrivateState(context, requestId);
}

/** Terminal metadata is never a successful outcome while private pending state survives. */
export function assertTerminalPrivateState(context: StoreContext, requestId: string): void {
  const row = context.database
    .query<{ readonly count: number }, [string]>(
      `SELECT (SELECT count(*) FROM request_payloads WHERE request_id = ?1) +
              (SELECT count(*) FROM request_wait_edges WHERE request_id = ?1) AS count`,
    )
    .get(requestId);
  if (row?.count !== 0) {
    throw new StoreIntegrityError("Terminal request private state was not erased.");
  }
}

/** Pending graph state must exactly match the participant tuple bound by its parent request. */
export function assertPendingWaitEdge(
  context: StoreContext,
  request: Pick<RequestMetadata, "id" | "workspaceKey" | "sourceSessionId" | "targetSessionId">,
): void {
  const edge = context.database
    .query<{ readonly count: number }, [string, string, string, string]>(
      `SELECT count(*) AS count FROM request_wait_edges
       WHERE request_id = ? AND workspace_key = ?
         AND source_session_id = ? AND target_session_id = ?`,
    )
    .get(request.id, request.workspaceKey, request.sourceSessionId, request.targetSessionId);
  if (edge?.count !== 1) {
    throw new StoreIntegrityError("Stored pending request edge was invalid.");
  }
}

export function eraseStoredResult(context: StoreContext, requestId: string): void {
  context.database.run("DELETE FROM request_results WHERE request_id = ?", [requestId]);
  const row = context.database
    .query<{ readonly count: number }, [string]>(
      "SELECT count(*) AS count FROM request_results WHERE request_id = ?",
    )
    .get(requestId);
  if (row?.count !== 0) throw new StoreIntegrityError("The request result was not erased.");
}
