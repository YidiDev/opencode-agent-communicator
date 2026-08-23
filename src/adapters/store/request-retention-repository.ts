import type { RequestRetentionResult } from "../../application/request-ports";
import type { FencingToken } from "../../domain/ownership";
import type { WorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import {
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
} from "./request-repository-shared";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export const requestMetadataRetentionMs = 30 * 24 * 60 * 60 * 1_000;

export class RequestRetentionRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  collect(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): RequestRetentionResult {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    )
      return { ok: false, code: "state_conflict" };
    const atLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const storeNowMs = requestStoreNowMs(this.context);
        const metadataCutoffMs = storeNowMs - requestMetadataRetentionMs;
        const rateCutoffMs = storeNowMs - this.context.limits.rateWindowMs;
        const requests = this.context.database
          .query<{ readonly id: unknown }, [string, number, number]>(
            `SELECT id FROM requests INDEXED BY requests_metadata_gc
             WHERE workspace_key = ? AND resolution_state <> 'pending'
               AND result_state <> 'available' AND resolved_at_ms <= ?
             ORDER BY resolved_at_ms, id LIMIT ?`,
          )
          .all(input.workspaceKey, metadataCutoffMs, input.limit);
        for (const request of requests) {
          if (typeof request.id !== "string") {
            throw new StoreIntegrityError("Request retention selection was malformed.");
          }
          const deleted = this.context.database.run(
            "DELETE FROM requests WHERE workspace_key = ? AND id = ?",
            [input.workspaceKey, request.id],
          );
          if (deleted.changes < 1) {
            throw new StoreIntegrityError("Request retention deletion lost its selected row.");
          }
        }
        const rates = this.context.database.run(
          `DELETE FROM request_rate_events WHERE sequence IN (
             SELECT sequence FROM request_rate_events
             WHERE workspace_key = ? AND occurred_at_ms <= ?
             ORDER BY occurred_at_ms, sequence LIMIT ?
           )`,
          [input.workspaceKey, rateCutoffMs, input.limit],
        );
        return {
          ok: true as const,
          deletedRequests: requests.length,
          deletedRateEvents: rates.changes,
        };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }
}
