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
}
