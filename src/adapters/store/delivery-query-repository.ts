import type { StartupRecoveryBarrier } from "../../application/delivery-ports";
import type { DeliveryMetadata, DeliveryParticipantRole } from "../../domain/deliveries";
import { type FencingToken, OwnershipLostFault } from "../../domain/ownership";
import { type DeliveryRow, deliveryMetadataColumns, hydrateDelivery } from "./delivery-rows";
import type { OwnershipRepository } from "./ownership-repository";
import type { StoreContext } from "./store-types";
import { StoreIntegrityError } from "./store-types";

export class DeliveryQueryRepository {
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
  }): readonly DeliveryMetadata[] {
    this.ownership.assertCurrent(input.fencingToken);
    if (input.workspaceKey !== this.context.workspaceKey) {
      throw new StoreIntegrityError("The recovery query is outside the configured workspace.");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new StoreIntegrityError("The recovery query limit is invalid.");
    }
    let rows: DeliveryRow[];
    if (input.state === "submitting") {
      if (input.excludeClaimedByToken === undefined || input.startupBarrier === undefined) {
        throw new OwnershipLostFault("Submitting recovery requires a startup barrier.");
      }
      this.ownership.assertBarrier(input.startupBarrier, input.fencingToken);
      rows = this.context.database
        .query<DeliveryRow, [string, number, number]>(
          `SELECT ${deliveryMetadataColumns} FROM deliveries
           WHERE workspace_key = ? AND state = 'submitting' AND claimed_fencing_token != ?
           ORDER BY created_at_ms, id LIMIT ?`,
        )
        .all(input.workspaceKey, input.excludeClaimedByToken, input.limit);
    } else {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      rows = this.context.database
        .query<DeliveryRow, [string, number]>(
          `SELECT ${deliveryMetadataColumns} FROM deliveries
           WHERE workspace_key = ? AND state = 'prepared' ORDER BY created_at_ms, id LIMIT ?`,
        )
        .all(input.workspaceKey, input.limit);
    }
    return rows.map(hydrateDelivery);
  }

  getForParticipant(input: {
    readonly workspaceKey: string;
    readonly deliveryId: string;
    readonly participantSessionId: string;
  }): { readonly role: DeliveryParticipantRole; readonly delivery: DeliveryMetadata } | undefined {
    if (input.workspaceKey !== this.context.workspaceKey) return undefined;
    const token = this.ownership.assertImplicitCurrent();
    this.ownership.assertOrdinaryWorkAllowed(token);
    const row = this.context.database
      .query<DeliveryRow & { readonly role: unknown }, [string, string, string, string, string]>(
        `SELECT ${deliveryMetadataColumns},
           CASE WHEN source_session_id = ? THEN 'source' ELSE 'target' END AS role
         FROM deliveries WHERE workspace_key = ? AND id = ?
           AND (source_session_id = ? OR target_session_id = ?)`,
      )
      .get(
        input.participantSessionId,
        input.workspaceKey,
        input.deliveryId,
        input.participantSessionId,
        input.participantSessionId,
      );
    if (!row) return undefined;
    if (row.role !== "source" && row.role !== "target") {
      throw new StoreIntegrityError("Stored delivery participant role was malformed.");
    }
    return { role: row.role, delivery: hydrateDelivery(row) };
  }
}
