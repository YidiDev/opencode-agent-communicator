import type {
  NextPendingRequestDeadline,
  RequestRecoveryPersistencePort,
} from "../../application/request-ports";
import { validateRequestId } from "../../domain/generated-ids";
import type { FencingToken } from "../../domain/ownership";
import { OwnershipLostFault } from "../../domain/ownership";
import type { RequestMetadata } from "../../domain/request-types";
import type { OwnershipRepository } from "./ownership-repository";
import { requestStoreNowMs } from "./request-repository-shared";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export const requestNextPendingDeadlineSql = `SELECT deadline_at_ms AS deadlineAtMs
  FROM requests INDEXED BY requests_deadline
  WHERE workspace_key = ? AND resolution_state = 'pending'
  ORDER BY deadline_at_ms, id LIMIT 1`;

export const requestPreparedRecoveryFirstPageSql = `SELECT ${requestMetadataColumns}
  FROM requests INDEXED BY requests_prepared_recovery
  WHERE workspace_key = ? AND resolution_state = 'pending' AND delivery_state = 'prepared'
    AND delivery_transport = 'native' AND deadline_at_ms > ?
  ORDER BY created_at_ms, id LIMIT ?`;

export const requestPreparedRecoveryAfterSql = `SELECT ${requestMetadataColumns}
  FROM requests INDEXED BY requests_prepared_recovery
  WHERE workspace_key = ? AND resolution_state = 'pending' AND delivery_state = 'prepared'
    AND delivery_transport = 'native' AND deadline_at_ms > ? AND (created_at_ms, id) > (?, ?)
  ORDER BY created_at_ms, id LIMIT ?`;

export class RequestQueryRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  readNextPendingDeadline(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: string;
  }): NextPendingRequestDeadline {
    const read = this.context.database.transaction(() => {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      if (input.workspaceKey !== this.context.workspaceKey) {
        throw new StoreIntegrityError(
          "The request deadline query is outside the configured workspace.",
        );
      }
      const storeObservedAtMs = requestStoreNowMs(this.context);
      const row = this.context.database
        .query<{ readonly deadlineAtMs: unknown }, [string]>(requestNextPendingDeadlineSql)
        .get(input.workspaceKey);
      if (row && (!Number.isSafeInteger(row.deadlineAtMs) || (row.deadlineAtMs as number) < 0)) {
        throw new StoreIntegrityError("The next request deadline was malformed.");
      }
      const maximumSleepMs = Math.floor(this.context.leaseDurationMs / 3);
      if (!Number.isSafeInteger(maximumSleepMs) || maximumSleepMs < 1) {
        throw new StoreIntegrityError("The request schedule lease interval was malformed.");
      }
      return Object.freeze({
        storeObservedAtMs,
        maximumSleepMs,
        ...(row ? { nextDeadlineAtMs: row.deadlineAtMs as number } : {}),
      });
    });
    return read.immediate();
  }

  listRecoverable(
    input: Parameters<RequestRecoveryPersistencePort["listRecoverableRequests"]>[0],
  ): readonly RequestMetadata[] {
    this.ownership.assertCurrent(input.fencingToken);
    if (input.workspaceKey !== this.context.workspaceKey) {
      throw new StoreIntegrityError(
        "The request recovery query is outside the configured workspace.",
      );
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new StoreIntegrityError("The request recovery query limit is invalid.");
    }
    let rows: RequestRow[];
    if (input.state === "submitting") {
      if (input.excludeClaimedByToken === undefined || input.startupBarrier === undefined) {
        throw new OwnershipLostFault("Submitting request recovery requires a startup barrier.");
      }
      if (input.excludeClaimedByToken !== input.fencingToken) {
        throw new OwnershipLostFault("Request recovery exclusion must match its fencing token.");
      }
      this.ownership.assertBarrier(input.startupBarrier, input.fencingToken);
      rows = this.context.database
        .query<RequestRow, [string, number, number]>(
          `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_submitting_recovery
           WHERE workspace_key = ? AND delivery_transport = 'native'
             AND delivery_state = 'submitting' AND claimed_fencing_token != ?
           ORDER BY created_at_ms, id LIMIT ?`,
        )
        .all(input.workspaceKey, input.excludeClaimedByToken, input.limit);
    } else {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      const storeNowMs = requestStoreNowMs(this.context);
      if (input.cursor === undefined) {
        rows = this.context.database
          .query<RequestRow, [string, number, number]>(requestPreparedRecoveryFirstPageSql)
          .all(input.workspaceKey, storeNowMs, input.limit);
      } else {
        if (
          !Number.isSafeInteger(input.cursor.createdAtMs) ||
          input.cursor.createdAtMs < 0 ||
          !validateRequestId(input.cursor.id).ok
        ) {
          throw new StoreIntegrityError("The request recovery cursor is malformed.");
        }
        rows = this.context.database
          .query<RequestRow, [string, number, number, string, number]>(
            requestPreparedRecoveryAfterSql,
          )
          .all(
            input.workspaceKey,
            storeNowMs,
            input.cursor.createdAtMs,
            input.cursor.id,
            input.limit,
          );
      }
    }
    return rows.map(hydrateRequest);
  }
}
