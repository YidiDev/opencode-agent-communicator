import { type Database, constants as sqliteConstants } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { OperationControl, StartupRecoveryBarrier } from "../../application/delivery-ports";
import type { StartOperationPersistencePort } from "../../application/session-start-ports";
import { type FencingToken, OwnershipLostFault } from "../../domain/ownership";
import { validateWorkspaceKey } from "../../domain/workspaces";
import { AdvisoryLockRepository } from "./advisory-lock-repository";
import { ContextAdmissionRepository } from "./context-admission-repository";
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
import { RequestDeletionRepository } from "./request-deletion-repository";
import { RequestDeliveryRepository } from "./request-delivery-repository";
import { RequestParticipantQueryRepository } from "./request-participant-query-repository";
import { RequestQueryRepository } from "./request-query-repository";
import { RequestRepository } from "./request-repository";
import { RequestResultRetentionRepository } from "./request-result-retention-repository";
import { RequestRetentionRepository } from "./request-retention-repository";
import { RequestStopRepository } from "./request-stop-repository";
import { RequestTerminalRepository } from "./request-terminal-repository";
import { SqliteStoreOperationAccess } from "./sqlite-store-operation-access";
import { StartOperationRepository } from "./start-operation-repository";
import { createStartOperationStoreFacade } from "./start-operation-store-facade";
import { StoreMaintenanceRepository } from "./store-maintenance-repository";
import {
  checkpointDatabase,
  defaultDatabaseLifecycle,
  integerStoreOption,
  rethrowSanitizedStorageError,
} from "./store-runtime-helpers";
import {
  type LinuxBunSqliteStoreOptions,
  resolveStoreLimits,
  type SqliteDatabaseLifecycle,
  type StoreContext,
  StoreSecurityError,
  sqliteStoreDefaultLeaseDurationMs,
  sqliteStoreDefaultTakeoverGraceMs,
} from "./store-types";

function retainCloseFailure(cause: unknown, pendingError: unknown): unknown {
  return cause instanceof OwnershipLostFault ? pendingError : cause;
}

export class SqliteStoreCore {
  readonly databasePath: string;
  readonly schemaVersion = sqliteStoreMigrations.length;
  readonly starts: StartOperationPersistencePort;
  protected readonly ownershipRepository: OwnershipRepository;
  protected readonly advisoryLockRepository: AdvisoryLockRepository;
  protected readonly deliveryRepository: DeliveryRepository;
  protected readonly contextAdmissionRepository: ContextAdmissionRepository;
  protected readonly deliveryQueryRepository: DeliveryQueryRepository;
  protected readonly requestRepository: RequestRepository;
  protected readonly requestDeliveryRepository: RequestDeliveryRepository;
  protected readonly requestDeletionRepository: RequestDeletionRepository;
  protected readonly requestQueryRepository: RequestQueryRepository;
  protected readonly requestParticipantQueryRepository: RequestParticipantQueryRepository;
  protected readonly requestRetentionRepository: RequestRetentionRepository;
  protected readonly requestTerminalRepository: RequestTerminalRepository;
  protected readonly requestResultRetentionRepository: RequestResultRetentionRepository;
  protected readonly requestStopRepository: RequestStopRepository;
  protected readonly maintenanceRepository: StoreMaintenanceRepository;
  protected readonly startRepository: StartOperationRepository;
  protected readonly access: SqliteStoreOperationAccess;
  private readonly database: Database;
  private readonly privateState: PreparedPrivateState;
  private readonly maximumDatabaseBytes: number;
  private readonly databaseLifecycle: SqliteDatabaseLifecycle;
  protected readonly context: StoreContext;
  private isClosed = false;

  constructor(options: LinuxBunSqliteStoreOptions) {
    const limits = resolveStoreLimits(options.limits);
    const workspace = validateWorkspaceKey(options.workspaceKey);
    if (!workspace.ok) throw new StoreSecurityError("The store workspace key is malformed.");
    const ownerLabel = options.ownerId ?? "backend";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerLabel)) {
      throw new StoreSecurityError("The backend owner identifier is malformed.");
    }
    const ownerGenerationId = randomUUID();
    const leaseDurationMs = integerStoreOption(
      "leaseDurationMs",
      options.leaseDurationMs ?? sqliteStoreDefaultLeaseDurationMs,
      1_000,
      300_000,
    );
    const takeoverGraceMs = integerStoreOption(
      "takeoverGraceMs",
      options.takeoverGraceMs ?? sqliteStoreDefaultTakeoverGraceMs,
      0,
      leaseDurationMs,
    );
    const busyTimeoutMs = integerStoreOption(
      "busyTimeoutMs",
      options.busyTimeoutMs ?? 2_000,
      1,
      30_000,
    );
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
      sqliteConstants.SQLITE_OPEN_EXRESCODE |
      sqliteConstants.SQLITE_OPEN_NOFOLLOW;
    try {
      this.privateState.assertPathIdentity();
      this.database = this.databaseLifecycle.open(this.privateState.sqliteDatabasePath, flags);
      this.privateState.assertPathIdentity();
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
      } finally {
        this.privateState.close();
        this.isClosed = true;
      }
      rethrowSanitizedStorageError(cause, "SQLite state initialization failed.");
    }
    this.context = {
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
    this.access = new SqliteStoreOperationAccess(
      this.context,
      this.privateState,
      this.maximumDatabaseBytes,
      (operation) => this.accessOperation(operation),
      retainCloseFailure,
    );
    this.ownershipRepository = new OwnershipRepository(this.context);
    this.advisoryLockRepository = new AdvisoryLockRepository(
      this.context,
      this.ownershipRepository,
    );
    this.deliveryRepository = new DeliveryRepository(this.context, this.ownershipRepository);
    this.contextAdmissionRepository = new ContextAdmissionRepository(
      this.context,
      this.ownershipRepository,
    );
    this.deliveryQueryRepository = new DeliveryQueryRepository(
      this.context,
      this.ownershipRepository,
    );
    this.requestRepository = new RequestRepository(
      this.context,
      this.ownershipRepository,
      this.contextAdmissionRepository,
    );
    this.requestDeliveryRepository = new RequestDeliveryRepository(
      this.context,
      this.ownershipRepository,
    );
    this.requestDeletionRepository = new RequestDeletionRepository(
      this.context,
      this.ownershipRepository,
    );
    this.requestQueryRepository = new RequestQueryRepository(
      this.context,
      this.ownershipRepository,
    );
    this.requestRetentionRepository = new RequestRetentionRepository(
      this.context,
      this.ownershipRepository,
    );
    this.requestTerminalRepository = new RequestTerminalRepository(
      this.context,
      this.ownershipRepository,
    );
    this.requestResultRetentionRepository = new RequestResultRetentionRepository(
      this.context,
      this.ownershipRepository,
    );
    this.requestStopRepository = new RequestStopRepository(this.context, this.ownershipRepository);
    this.startRepository = new StartOperationRepository(this.context, this.ownershipRepository);
    this.starts = createStartOperationStoreFacade(this.startRepository, (operation) =>
      this.access.mutate(operation),
    );
    this.requestParticipantQueryRepository = new RequestParticipantQueryRepository(
      this.context,
      this.ownershipRepository,
      this.requestRepository,
      this.requestResultRetentionRepository,
    );
    this.maintenanceRepository = new StoreMaintenanceRepository(
      this.context,
      this.ownershipRepository,
    );
  }

  async acquire(): Promise<FencingToken> {
    this.assertOpen();
    try {
      const token = this.ownershipRepository.acquire();
      try {
        this.ownershipRepository.assertCurrent(token);
        this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () =>
          checkpointDatabase(this.database),
        );
        this.ownershipRepository.assertCurrent(token);
        const maximumPages = configureOwnedDatabase(this.database, this.maximumDatabaseBytes);
        this.ownershipRepository.assertCurrent(token);
        this.context.maximumPageCount = maximumPages;
        this.privateState.verifySqliteFiles();
        return token;
      } catch (cause: unknown) {
        this.ownershipRepository.relinquish();
        throw cause;
      }
    } catch (cause: unknown) {
      rethrowSanitizedStorageError(cause, "SQLite ownership acquisition failed.");
    }
  }

  async isCurrent(token: FencingToken): Promise<boolean> {
    this.assertOpen();
    return this.context.localToken === token
      ? this.access.mutate(() => this.ownershipRepository.isCurrent(token))
      : this.access.inspect(() => this.ownershipRepository.isCurrent(token));
  }

  ownershipTakeoverDelayMs(): number {
    this.assertOpen();
    return this.access.inspect(() => this.ownershipRepository.takeoverDelayMs());
  }

  async establish(token: FencingToken, control: OperationControl): Promise<StartupRecoveryBarrier> {
    this.assertOpen();
    return this.access.inspect(() => this.ownershipRepository.establish(token, control));
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.access.close(this.ownershipRepository, this.databaseLifecycle);
  }

  protected assertOpen(): void {
    if (this.isClosed) throw new OwnershipLostFault("The SQLite store is closed.");
  }

  private accessOperation<Value>(operation: () => Value): Value {
    try {
      if (this.ownershipRepository.hasCurrentLease()) {
        this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () =>
          checkpointDatabase(this.database),
        );
      }
      const result = operation();
      this.privateState.verifySqliteFiles();
      return result;
    } catch (cause: unknown) {
      rethrowSanitizedStorageError(cause, "SQLite storage operation failed.");
    }
  }
}
