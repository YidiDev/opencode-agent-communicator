import type { FencingToken } from "../../domain/ownership";
import type { WorkspaceKey } from "../../domain/workspaces";
import { readNumericPragma } from "./database-configuration";
import type { OwnershipRepository } from "./ownership-repository";
import { requestStoreNowMs } from "./request-repository-shared";
import { type StoreContext, StoreIntegrityError } from "./store-types";

const deliveryMetadataRetentionMs = 30 * 24 * 60 * 60 * 1_000;

export interface StoreStorageDiagnostics {
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly busyTimeoutMs: number;
  readonly synchronous: number;
  readonly tempStore: number;
  readonly secureDelete: number;
  readonly trustedSchema: number;
  readonly walAutocheckpointPages: number;
  readonly cacheSize: number;
  readonly mmapBytes: number;
  readonly pageSize: number;
  readonly maxPageCount: number;
  readonly journalSizeLimit: number;
}

export class StoreMaintenanceRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  garbageCollectDeliveryMetadata(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Readonly<{
    readonly ok: true;
    readonly deletedDeliveries: number;
    readonly deletedRateEvents: number;
  }> {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    ) {
      throw new StoreIntegrityError("The metadata GC batch limit is invalid.");
    }
    const collect = this.context.database.transaction(() => {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      const storeNowMs = requestStoreNowMs(this.context);
      const metadataCutoffMs = Math.max(0, storeNowMs - deliveryMetadataRetentionMs);
      const rateCutoffMs = Math.max(0, storeNowMs - this.context.limits.rateWindowMs);
      const deleted = this.context.database.run(
        `DELETE FROM deliveries WHERE id IN (
           SELECT id FROM deliveries
           WHERE state IN ('admission_unknown','admitted','promoted','failed','cancelled')
             AND workspace_key = ? AND updated_at_ms <= ? ORDER BY updated_at_ms, id LIMIT ?
         )`,
        [input.workspaceKey, metadataCutoffMs, input.limit],
      );
      const rateEvents = this.context.database.run(
        `DELETE FROM delivery_rate_events WHERE sequence IN (
           SELECT sequence FROM delivery_rate_events
           WHERE workspace_key = ? AND occurred_at_ms <= ?
           ORDER BY occurred_at_ms, sequence LIMIT ?
         )`,
        [input.workspaceKey, rateCutoffMs, input.limit],
      );
      return {
        ok: true as const,
        deletedDeliveries: deleted.changes,
        deletedRateEvents: rateEvents.changes,
      };
    });
    return collect.immediate();
  }

  readStorageDiagnostics(): StoreStorageDiagnostics {
    const token = this.ownership.assertImplicitCurrent();
    this.ownership.assertOrdinaryWorkAllowed(token);
    const journal = this.context.database
      .query<Record<string, unknown>, []>("PRAGMA journal_mode")
      .get();
    const journalMode = Object.values(journal ?? {})[0];
    if (typeof journalMode !== "string") {
      throw new StoreIntegrityError("SQLite journal mode diagnostics were malformed.");
    }
    return {
      journalMode,
      foreignKeys: readNumericPragma(this.context.database, "foreign_keys"),
      busyTimeoutMs: readNumericPragma(this.context.database, "busy_timeout"),
      synchronous: readNumericPragma(this.context.database, "synchronous"),
      tempStore: readNumericPragma(this.context.database, "temp_store"),
      secureDelete: readNumericPragma(this.context.database, "secure_delete"),
      trustedSchema: readNumericPragma(this.context.database, "trusted_schema"),
      walAutocheckpointPages: readNumericPragma(this.context.database, "wal_autocheckpoint"),
      cacheSize: readNumericPragma(this.context.database, "cache_size"),
      mmapBytes: readNumericPragma(this.context.database, "mmap_size"),
      pageSize: readNumericPragma(this.context.database, "page_size"),
      maxPageCount: readNumericPragma(this.context.database, "max_page_count"),
      journalSizeLimit: readNumericPragma(this.context.database, "journal_size_limit"),
    };
  }
}
