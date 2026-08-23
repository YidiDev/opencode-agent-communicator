import type { StartupRecoveryBarrier } from "../../application/delivery-ports";
import type { FencingToken } from "../../domain/ownership";
import { OwnershipLostFault } from "../../domain/ownership";
import type { RequestMetadata } from "../../domain/request-types";
import type { OwnershipRepository } from "./ownership-repository";
import { requestStoreNowMs } from "./request-repository-shared";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export class RequestQueryRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  listRecoverable(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: string;
    readonly state: "prepared" | "submitting";
    readonly limit: number;
    readonly excludeClaimedByToken?: FencingToken;
    readonly startupBarrier?: StartupRecoveryBarrier;
  }): readonly RequestMetadata[] {
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
           WHERE workspace_key = ? AND delivery_state = 'submitting' AND claimed_fencing_token != ?
           ORDER BY created_at_ms, id LIMIT ?`,
        )
        .all(input.workspaceKey, input.excludeClaimedByToken, input.limit);
    } else {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      const storeNowMs = requestStoreNowMs(this.context);
      rows = this.context.database
        .query<RequestRow, [string, number, number]>(
          `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_prepared_recovery
           WHERE workspace_key = ? AND resolution_state = 'pending' AND delivery_state = 'prepared'
             AND deadline_at_ms > ?
           ORDER BY created_at_ms, id LIMIT ?`,
        )
        .all(input.workspaceKey, storeNowMs, input.limit);
    }
    return rows.map(hydrateRequest);
  }
}
