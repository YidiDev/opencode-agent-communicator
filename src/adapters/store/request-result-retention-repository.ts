import type {
  ExpireAvailableResultsResult,
  ExpiredAnsweredOrReachedRequestMetadata,
} from "../../application/request-ports";
import type { FencingToken } from "../../domain/ownership";
import type { WorkspaceKey } from "../../domain/workspaces";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import {
  eraseStoredResult,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
  selectRequest,
} from "./request-repository-shared";
import { validateStoredResultState } from "./request-result-validation";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export class RequestResultRetentionRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  expireAvailable(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): ExpireAvailableResultsResult {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateWorkspaceKey(input.workspaceKey).ok ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      return { ok: false, code: "state_conflict" };
    }
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction((): ExpireAvailableResultsResult => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          const nowMs = requestStoreNowMs(this.context);
          const rows = this.context.database
            .query<RequestRow, [string, number, number]>(
              `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_result_expiry
             WHERE workspace_key = ? AND result_state = 'available' AND result_expires_at_ms <= ?
             ORDER BY result_expires_at_ms, id LIMIT ?`,
            )
            .all(input.workspaceKey, nowMs, input.limit);
          const requests: ExpiredAnsweredOrReachedRequestMetadata[] = [];
          for (const row of rows) {
            const before = hydrateRequest(row);
            eraseStoredResult(this.context, before.id);
            const changed = this.context.database.run(
              `UPDATE requests SET result_state = 'expired', result_expired_at_ms = ?,
               updated_at_ms = ?, result_byte_length = NULL, result_sha256 = NULL
             WHERE workspace_key = ? AND id = ? AND result_state = 'available'
               AND result_expires_at_ms <= ?`,
              [nowMs, nowMs, input.workspaceKey, before.id, nowMs],
            );
            if (changed.changes !== 1) {
              throw new StoreIntegrityError("The request result expiry CAS failed.");
            }
            const request = selectRequest(this.context, input.workspaceKey, before.id);
            if (!request) throw new StoreIntegrityError("The expired result metadata was absent.");
            validateStoredResultState(this.context, request);
            if (
              (request.resolutionState !== "answered" && request.resolutionState !== "reached") ||
              request.resultState !== "expired"
            ) {
              throw new StoreIntegrityError("The expired request result state was malformed.");
            }
            requests.push(request);
          }
          return { ok: true, requests };
        })
        .immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }
}
