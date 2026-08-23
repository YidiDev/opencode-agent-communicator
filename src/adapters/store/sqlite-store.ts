import { type Database, constants as sqliteConstants } from "bun:sqlite";
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
import type {
  CompleteRequestDeliveryInput,
  ExpireDueRequestsResult,
  PrepareRequestInput,
  RequestAdmissionPersistencePort,
  RequestClaimResult,
  RequestParticipantQueryPort,
  RequestRecoveryPersistencePort,
  RequestResultRetentionPersistencePort,
  RequestRetentionPersistencePort,
  RequestRetentionResult,
  RequestStoreResult,
  RequestTerminalPersistencePort,
  RequestTransitionInput,
} from "../../application/request-ports";
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
import { RequestDeliveryRepository } from "./request-delivery-repository";
import { RequestParticipantQueryRepository } from "./request-participant-query-repository";
import { RequestQueryRepository } from "./request-query-repository";
import { RequestRepository } from "./request-repository";
import { RequestResultRetentionRepository } from "./request-result-retention-repository";
import { RequestRetentionRepository } from "./request-retention-repository";
import { RequestTerminalRepository } from "./request-terminal-repository";
import {
  StoreMaintenanceRepository,
  type StoreStorageDiagnostics,
} from "./store-maintenance-repository";
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
} from "./store-types";

export class LinuxBunSqliteStore
  implements
    OwnershipPort,
    DeliveryPersistencePort,
    RecoveryStartupBarrierPort,
    RequestAdmissionPersistencePort,
    RequestRecoveryPersistencePort,
    RequestRetentionPersistencePort,
    RequestTerminalPersistencePort,
    RequestResultRetentionPersistencePort,
    RequestParticipantQueryPort
{
  readonly databasePath: string;
  readonly schemaVersion = sqliteStoreMigrations.length;
  private readonly database: Database;
  private readonly ownershipRepository: OwnershipRepository;
  private readonly deliveryRepository: DeliveryRepository;
  private readonly deliveryQueryRepository: DeliveryQueryRepository;
  private readonly requestRepository: RequestRepository;
  private readonly requestDeliveryRepository: RequestDeliveryRepository;
  private readonly requestQueryRepository: RequestQueryRepository;
  private readonly requestParticipantQueryRepository: RequestParticipantQueryRepository;
  private readonly requestRetentionRepository: RequestRetentionRepository;
  private readonly requestTerminalRepository: RequestTerminalRepository;
  private readonly requestResultRetentionRepository: RequestResultRetentionRepository;
  private readonly maintenanceRepository: StoreMaintenanceRepository;
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
    const leaseDurationMs = integerStoreOption(
      "leaseDurationMs",
      options.leaseDurationMs ?? 15_000,
      1_000,
      300_000,
    );
    const takeoverGraceMs = integerStoreOption(
      "takeoverGraceMs",
      options.takeoverGraceMs ?? 1_000,
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
      rethrowSanitizedStorageError(cause, "SQLite state initialization failed.");
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
    this.requestRepository = new RequestRepository(context, this.ownershipRepository);
    this.requestDeliveryRepository = new RequestDeliveryRepository(
      context,
      this.ownershipRepository,
    );
    this.requestQueryRepository = new RequestQueryRepository(context, this.ownershipRepository);
    this.requestRetentionRepository = new RequestRetentionRepository(
      context,
      this.ownershipRepository,
    );
    this.requestTerminalRepository = new RequestTerminalRepository(
      context,
      this.ownershipRepository,
    );
    this.requestResultRetentionRepository = new RequestResultRetentionRepository(
      context,
      this.ownershipRepository,
    );
    this.requestParticipantQueryRepository = new RequestParticipantQueryRepository(
      context,
      this.ownershipRepository,
      this.requestRepository,
      this.requestResultRetentionRepository,
    );
    this.maintenanceRepository = new StoreMaintenanceRepository(context, this.ownershipRepository);
  }

  async acquire(): Promise<FencingToken> {
    this.assertOpen();
    try {
      const token = this.ownershipRepository.acquire();
      try {
        // These settings affect the database file or other connections. They are deliberately
        // delayed until after the serialized lease acquisition.
        this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () =>
          checkpointDatabase(this.database),
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
      rethrowSanitizedStorageError(cause, "SQLite ownership acquisition failed.");
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

  async createPrepared(input: PrepareDeliveryInput): Promise<DeliveryStoreResult>;
  async createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  async createPrepared(
    input: PrepareDeliveryInput | PrepareRequestInput,
  ): Promise<DeliveryStoreResult | RequestStoreResult> {
    this.assertOpen();
    return "request" in input
      ? this.mutate(() => this.requestRepository.createPrepared(input))
      : this.mutate(() => this.deliveryRepository.createPrepared(input));
  }

  async cancelPrepared(input: DeliveryTransitionInput): Promise<DeliveryStoreResult> {
    this.assertOpen();
    return this.mutate(() => this.deliveryRepository.cancelPrepared(input));
  }

  async claimPrepared(input: DeliveryTransitionInput): Promise<DeliveryClaimResult>;
  async claimPrepared(input: RequestTransitionInput): Promise<RequestClaimResult>;
  async claimPrepared(
    input: DeliveryTransitionInput | RequestTransitionInput,
  ): Promise<DeliveryClaimResult | RequestClaimResult> {
    this.assertOpen();
    return "requestId" in input
      ? this.mutate(() => this.requestRepository.claimPrepared(input))
      : this.mutate(() => this.deliveryRepository.claimPrepared(input));
  }

  async completeDelivery(input: CompleteRequestDeliveryInput): Promise<RequestStoreResult> {
    this.assertOpen();
    return this.mutate(() => this.requestDeliveryRepository.completeDelivery(input));
  }

  async expireDueRequests(
    input: Parameters<RequestAdmissionPersistencePort["expireDueRequests"]>[0],
  ): Promise<ExpireDueRequestsResult> {
    this.assertOpen();
    return this.mutate(() => this.requestRepository.expireDueRequests(input));
  }

  async listRecoverableRequests(
    input: Parameters<RequestRecoveryPersistencePort["listRecoverableRequests"]>[0],
  ): Promise<readonly import("../../domain/request-types").RequestMetadata[]> {
    this.assertOpen();
    return this.inspect(() => this.requestQueryRepository.listRecoverable(input));
  }

  async listForParticipant(
    input: Parameters<RequestParticipantQueryPort["listForParticipant"]>[0],
  ): ReturnType<RequestParticipantQueryPort["listForParticipant"]> {
    this.assertOpen();
    return this.inspect(() => this.requestParticipantQueryRepository.list(input));
  }

  async getParticipantRequest(
    input: Parameters<RequestParticipantQueryPort["getParticipantRequest"]>[0],
  ): ReturnType<RequestParticipantQueryPort["getParticipantRequest"]> {
    this.assertOpen();
    return this.inspect(() => this.requestParticipantQueryRepository.get(input));
  }

  async collectRequestRetention(
    input: Parameters<RequestRetentionPersistencePort["collectRequestRetention"]>[0],
  ): Promise<RequestRetentionResult> {
    this.assertOpen();
    return this.mutate(() => this.requestRetentionRepository.collect(input));
  }

  async answerAsk(
    input: Parameters<RequestTerminalPersistencePort["answerAsk"]>[0],
  ): ReturnType<RequestTerminalPersistencePort["answerAsk"]> {
    this.assertOpen();
    return this.mutate(() => this.requestTerminalRepository.answerAsk(input));
  }

  async signalWait(
    input: Parameters<RequestTerminalPersistencePort["signalWait"]>[0],
  ): ReturnType<RequestTerminalPersistencePort["signalWait"]> {
    this.assertOpen();
    return this.mutate(() => this.requestTerminalRepository.signalWait(input));
  }

  async cancelPending(
    input: Parameters<RequestTerminalPersistencePort["cancelPending"]>[0],
  ): ReturnType<RequestTerminalPersistencePort["cancelPending"]> {
    this.assertOpen();
    return this.mutate(() => this.requestTerminalRepository.cancelPending(input));
  }

  async acknowledgeResult(
    input: Parameters<RequestTerminalPersistencePort["acknowledgeResult"]>[0],
  ): ReturnType<RequestTerminalPersistencePort["acknowledgeResult"]> {
    this.assertOpen();
    return this.mutate(() => this.requestTerminalRepository.acknowledgeResult(input));
  }

  async expireAvailableResults(
    input: Parameters<RequestResultRetentionPersistencePort["expireAvailableResults"]>[0],
  ): ReturnType<RequestResultRetentionPersistencePort["expireAvailableResults"]> {
    this.assertOpen();
    return this.mutate(() => this.requestResultRetentionRepository.expireAvailable(input));
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
    return this.mutate(() => this.maintenanceRepository.garbageCollectDeliveryMetadata(input));
  }

  async readStorageDiagnostics(): Promise<StoreStorageDiagnostics> {
    this.assertOpen();
    return this.mutate(() => this.maintenanceRepository.readStorageDiagnostics());
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
          checkpointDatabase(this.database),
        );
        checkpointDatabase(this.database);
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
      rethrowSanitizedStorageError(pendingError, "The SQLite store could not be closed safely.");
    }
  }

  private assertOpen(): void {
    if (this.isClosed) throw new OwnershipLostFault("The SQLite store is closed.");
  }

  private mutate<Value>(operation: () => Value): Value {
    try {
      this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () =>
        checkpointDatabase(this.database),
      );
      const result = operation();
      this.privateState.verifySqliteFiles();
      return result;
    } catch (cause: unknown) {
      rethrowSanitizedStorageError(cause, "SQLite storage operation failed.");
    }
  }

  private inspect<Value>(operation: () => Value): Value {
    try {
      // Reads fence through isCurrent(), which may renew and therefore mutate ownership.
      this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () =>
        checkpointDatabase(this.database),
      );
      const result = operation();
      this.privateState.verifySqliteFiles();
      return result;
    } catch (cause: unknown) {
      rethrowSanitizedStorageError(cause, "SQLite storage operation failed.");
    }
  }
}
