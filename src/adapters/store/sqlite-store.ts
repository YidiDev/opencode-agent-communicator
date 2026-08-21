import { Database, constants as sqliteConstants } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type {
  CompleteSubmissionInput,
  DeliveryClaimResult,
  DeliveryPersistencePort,
  DeliveryStoreResult,
  DeliveryTransitionInput,
  OperationControl,
  OwnershipPort,
  PrepareDeliveryInput,
  RecoveryStartupBarrierPort,
  StartupRecoveryBarrier,
} from "../../application/delivery-ports";
import type { DeliveryMetadata, DeliveryParticipantRole } from "../../domain/deliveries";
import { type FencingToken, OwnershipLostFault } from "../../domain/ownership";
import type { SessionId } from "../../domain/sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "../../domain/workspaces";
import {
  configureDatabaseConnection,
  configureOwnedDatabase,
  readNumericPragma,
  verifyDatabase,
  verifyDatabaseCeiling,
} from "./database-configuration";
import { DeliveryQueryRepository } from "./delivery-query-repository";
import { DeliveryRepository } from "./delivery-repository";
import { type PreparedPrivateState, preparePrivateStatePath } from "./linux-private-path";
import { applyMigrations, sqliteStoreMigrations } from "./migrations";
import { OwnershipRepository } from "./ownership-repository";
import {
  type LinuxBunSqliteStoreOptions,
  resolveStoreLimits,
  type SqliteDatabaseLifecycle,
  type StoreContext,
  StoreIntegrityError,
  StoreSecurityError,
} from "./store-types";

const metadataRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const defaultDatabaseLifecycle: SqliteDatabaseLifecycle = {
  open: (path, flags) => new Database(path, flags),
  close: (database) => database.close(true),
};

function integerOption(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StoreSecurityError(`${name} is outside its supported range.`);
  }
  return value;
}

export class LinuxBunSqliteStore
  implements OwnershipPort, DeliveryPersistencePort, RecoveryStartupBarrierPort
{
  readonly databasePath: string;
  readonly schemaVersion = sqliteStoreMigrations.length;
  private readonly database: Database;
  private readonly ownershipRepository: OwnershipRepository;
  private readonly deliveryRepository: DeliveryRepository;
  private readonly deliveryQueryRepository: DeliveryQueryRepository;
  private readonly privateState: PreparedPrivateState;
  private readonly maximumDatabaseBytes: number;
  private readonly databaseLifecycle: SqliteDatabaseLifecycle;
  private readonly workspaceKey: WorkspaceKey;
  private readonly context: StoreContext;
  private isClosed = false;

  constructor(options: LinuxBunSqliteStoreOptions) {
    const limits = resolveStoreLimits(options.limits);
    const workspace = validateWorkspaceKey(options.workspaceKey);
    if (!workspace.ok) throw new StoreSecurityError("The store workspace key is malformed.");
    this.workspaceKey = workspace.value;
    const ownerLabel = options.ownerId ?? "backend";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerLabel)) {
      throw new StoreSecurityError("The backend owner identifier is malformed.");
    }
    const ownerGenerationId = randomUUID();
    const leaseDurationMs = integerOption(
      "leaseDurationMs",
      options.leaseDurationMs ?? 15_000,
      1_000,
      300_000,
    );
    const takeoverGraceMs = integerOption(
      "takeoverGraceMs",
      options.takeoverGraceMs ?? 1_000,
      0,
      leaseDurationMs,
    );
    const busyTimeoutMs = integerOption("busyTimeoutMs", options.busyTimeoutMs ?? 2_000, 1, 30_000);
    this.privateState = preparePrivateStatePath(
      options.stateDirectory,
      options.databaseFileName ?? "communicator.sqlite3",
      {
        ...(options.linuxPathSyscalls ? { syscalls: options.linuxPathSyscalls } : {}),
        ...(options.allowFuseStateFileSystem === undefined
          ? {}
          : { allowFuse: options.allowFuseStateFileSystem }),
      },
    );
    this.databasePath = this.privateState.canonicalDatabasePath;
    this.maximumDatabaseBytes = limits.databaseBytes;
    this.databaseLifecycle = options.sqliteDatabaseLifecycle ?? defaultDatabaseLifecycle;
    let maximumPageCount = 0;
    try {
      this.privateState.assertMutationCapacity(limits.databaseBytes, () => {
        throw new StoreSecurityError("An oversized existing SQLite sidecar cannot be trusted.");
      });
    } catch (cause: unknown) {
      this.privateState.close();
      throw cause;
    }
    const flags =
      sqliteConstants.SQLITE_OPEN_READWRITE |
      sqliteConstants.SQLITE_OPEN_CREATE |
      sqliteConstants.SQLITE_OPEN_PRIVATECACHE |
      sqliteConstants.SQLITE_OPEN_EXRESCODE;
    try {
      this.database = this.databaseLifecycle.open(this.privateState.sqliteDatabasePath, flags);
    } catch {
      this.privateState.close();
      throw new StoreSecurityError("The SQLite database could not be opened safely.");
    }
    try {
      configureDatabaseConnection(this.database, busyTimeoutMs);
      applyMigrations(this.database, (options.nowWallMs ?? Date.now)(), takeoverGraceMs);
      verifyDatabase(this.database);
      verifyDatabaseCeiling(this.database, limits.databaseBytes);
      this.privateState.verifySqliteFiles();
      maximumPageCount = readNumericPragma(this.database, "max_page_count");
    } catch (cause: unknown) {
      try {
        this.databaseLifecycle.close(this.database);
      } catch {
        // Initialization's primary sanitized failure wins over cleanup failure.
      } finally {
        this.privateState.close();
        this.isClosed = true;
      }
      this.rethrowSanitized(cause, "SQLite state initialization failed.");
    }
    const context: StoreContext = {
      database: this.database,
      limits,
      workspaceKey: workspace.value,
      ownerGenerationId,
      ownerLabel,
      leaseDurationMs,
      takeoverGraceMs,
      nowWallMs: options.nowWallMs ?? Date.now,
      nowMonotonicMs: options.nowMonotonicMs ?? performance.now.bind(performance),
      maximumPageCount,
      localToken: undefined,
      localExpiresMonotonicMs: 0,
      nextRenewMonotonicMs: 0,
      startupBlockedToken: undefined,
    };
    this.context = context;
    this.ownershipRepository = new OwnershipRepository(context);
    this.deliveryRepository = new DeliveryRepository(context, this.ownershipRepository);
    this.deliveryQueryRepository = new DeliveryQueryRepository(context, this.ownershipRepository);
  }

  async acquire(): Promise<FencingToken> {
    this.assertOpen();
    try {
      const token = this.ownershipRepository.acquire();
      try {
        // These settings affect the database file or other connections. They are deliberately
        // delayed until after the serialized lease acquisition.
        this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () =>
          this.checkpoint(),
        );
        const maximumPages = configureOwnedDatabase(this.database, this.maximumDatabaseBytes);
        this.ownershipRepository.assertCurrent(token);
        this.context.maximumPageCount = maximumPages;
        this.privateState.verifySqliteFiles();
        return token;
      } catch (cause: unknown) {
        // Explicit release bypasses takeover grace and is the final SQLite mutation in this path.
        this.ownershipRepository.relinquish();
        throw cause;
      }
    } catch (cause: unknown) {
      this.rethrowSanitized(cause, "SQLite ownership acquisition failed.");
    }
  }

  async isCurrent(token: FencingToken): Promise<boolean> {
    this.assertOpen();
    return this.mutate(() => this.ownershipRepository.isCurrent(token));
  }

  async establish(token: FencingToken, control: OperationControl): Promise<StartupRecoveryBarrier> {
    this.assertOpen();
    return this.inspect(() => this.ownershipRepository.establish(token, control));
  }

  async createPrepared(input: PrepareDeliveryInput): Promise<DeliveryStoreResult> {
    this.assertOpen();
    return this.mutate(() => this.deliveryRepository.createPrepared(input));
  }

  async cancelPrepared(input: DeliveryTransitionInput): Promise<DeliveryStoreResult> {
    this.assertOpen();
    return this.mutate(() => this.deliveryRepository.cancelPrepared(input));
  }

  async claimPrepared(input: DeliveryTransitionInput): Promise<DeliveryClaimResult> {
    this.assertOpen();
    return this.mutate(() => this.deliveryRepository.claimPrepared(input));
  }

  async completeSubmission(input: CompleteSubmissionInput): Promise<DeliveryStoreResult> {
    this.assertOpen();
    return this.mutate(() => this.deliveryRepository.completeSubmission(input));
  }

  async listRecoverable(
    input: Parameters<DeliveryPersistencePort["listRecoverable"]>[0],
  ): Promise<readonly DeliveryMetadata[]> {
    this.assertOpen();
    return this.inspect(() => this.deliveryQueryRepository.listRecoverable(input));
  }

  async getForParticipant(input: {
    readonly workspaceKey: WorkspaceKey;
    readonly deliveryId: Parameters<DeliveryPersistencePort["getForParticipant"]>[0]["deliveryId"];
    readonly participantSessionId: SessionId;
  }): Promise<
    { readonly role: DeliveryParticipantRole; readonly delivery: DeliveryMetadata } | undefined
  > {
    this.assertOpen();
    return this.inspect(() => this.deliveryQueryRepository.getForParticipant(input));
  }

  async garbageCollectMetadata(input: {
    readonly fencingToken: FencingToken;
    readonly nowMs: number;
    readonly limit: number;
  }): Promise<number> {
    this.assertOpen();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new StoreIntegrityError("The metadata GC batch limit is invalid.");
    }
    const collect = this.database.transaction(() => {
      this.ownershipRepository.assertOrdinaryWorkAllowed(input.fencingToken);
      const deleted = this.database.run(
        `DELETE FROM deliveries WHERE id IN (
           SELECT id FROM deliveries
           WHERE state IN ('admission_unknown','admitted','promoted','failed','cancelled')
             AND workspace_key = ? AND updated_at_ms <= ? ORDER BY updated_at_ms, id LIMIT ?
         )`,
        [this.workspaceKey, Math.max(0, input.nowMs - metadataRetentionMs), input.limit],
      );
      this.database.run(
        `DELETE FROM delivery_rate_events WHERE sequence IN (
              SELECT sequence FROM delivery_rate_events
              WHERE workspace_key = ? AND occurred_at_ms <= ?
             ORDER BY occurred_at_ms, sequence LIMIT ?
           )`,
        [this.workspaceKey, Math.max(0, input.nowMs - metadataRetentionMs), input.limit],
      );
      return deleted.changes;
    });
    return this.mutate(() => collect.immediate());
  }

  async readStorageDiagnostics(): Promise<{
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
  }> {
    this.assertOpen();
    return this.mutate(() => {
      const token = this.ownershipRepository.assertImplicitCurrent();
      this.ownershipRepository.assertOrdinaryWorkAllowed(token);
      const journal = this.database.query<Record<string, unknown>, []>("PRAGMA journal_mode").get();
      const journalMode = Object.values(journal ?? {})[0];
      if (typeof journalMode !== "string") {
        throw new StoreIntegrityError("SQLite journal mode diagnostics were malformed.");
      }
      return {
        journalMode,
        foreignKeys: readNumericPragma(this.database, "foreign_keys"),
        busyTimeoutMs: readNumericPragma(this.database, "busy_timeout"),
        synchronous: readNumericPragma(this.database, "synchronous"),
        tempStore: readNumericPragma(this.database, "temp_store"),
        secureDelete: readNumericPragma(this.database, "secure_delete"),
        trustedSchema: readNumericPragma(this.database, "trusted_schema"),
        walAutocheckpointPages: readNumericPragma(this.database, "wal_autocheckpoint"),
        cacheSize: readNumericPragma(this.database, "cache_size"),
        mmapBytes: readNumericPragma(this.database, "mmap_size"),
        pageSize: readNumericPragma(this.database, "page_size"),
        maxPageCount: readNumericPragma(this.database, "max_page_count"),
        journalSizeLimit: readNumericPragma(this.database, "journal_size_limit"),
      };
    });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    let pendingError: unknown;
    let hasCurrentLease = false;
    try {
      hasCurrentLease = this.ownershipRepository.hasCurrentLease();
    } catch (cause: unknown) {
      pendingError = cause;
    }
    if (hasCurrentLease) {
      try {
        this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () =>
          this.checkpoint(),
        );
        this.checkpoint();
      } catch (cause: unknown) {
        if (!(cause instanceof OwnershipLostFault)) pendingError = cause;
      }
      try {
        // Final SQLite mutation. Everything below only closes already-open handles.
        this.ownershipRepository.relinquish();
      } catch (cause: unknown) {
        if (!(cause instanceof OwnershipLostFault)) pendingError ??= cause;
      }
    }
    try {
      this.databaseLifecycle.close(this.database);
    } catch (cause: unknown) {
      pendingError ??= cause;
    } finally {
      this.privateState.close();
    }
    if (pendingError !== undefined) {
      this.rethrowSanitized(pendingError, "The SQLite store could not be closed safely.");
    }
  }

  private assertOpen(): void {
    if (this.isClosed) throw new OwnershipLostFault("The SQLite store is closed.");
  }

  private mutate<Value>(operation: () => Value): Value {
    try {
      this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () => this.checkpoint());
      const result = operation();
      this.privateState.verifySqliteFiles();
      return result;
    } catch (cause: unknown) {
      this.rethrowSanitized(cause, "SQLite storage operation failed.");
    }
  }

  private inspect<Value>(operation: () => Value): Value {
    try {
      // Reads fence through isCurrent(), which may renew and therefore mutate ownership.
      this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () => this.checkpoint());
      const result = operation();
      this.privateState.verifySqliteFiles();
      return result;
    } catch (cause: unknown) {
      this.rethrowSanitized(cause, "SQLite storage operation failed.");
    }
  }

  private checkpoint(): void {
    const row = this.database
      .query<Record<string, unknown>, []>("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    const values = Object.values(row ?? {});
    if (
      values.length !== 3 ||
      values.some((value) => typeof value !== "number" || !Number.isSafeInteger(value)) ||
      values[0] !== 0
    ) {
      throw new StoreSecurityError("SQLite WAL checkpointing is blocked.");
    }
  }

  private rethrowSanitized(cause: unknown, message: string): never {
    if (
      cause instanceof StoreSecurityError ||
      cause instanceof StoreIntegrityError ||
      cause instanceof OwnershipLostFault
    ) {
      throw cause;
    }
    throw new StoreIntegrityError(message);
  }
}
