import type { Database } from "bun:sqlite";

import type { FencingToken } from "../../domain/ownership";
import {
  availableResultsPerWorkspaceHardCeiling,
  deliveryRecordsPerWorkspaceHardCeiling,
  pendingRequestsPerWorkspaceHardCeiling,
} from "../../domain/safety-ceilings";
import type { WorkspaceKey } from "../../domain/workspaces";
import type { LinuxPathSyscalls, SqliteDatabaseLifecycle } from "./store-boundaries";
import { StoreSecurityError } from "./store-errors";

export type { LinuxFileStat, LinuxPathSyscalls, SqliteDatabaseLifecycle } from "./store-boundaries";
export { OwnershipUnavailableError, StoreIntegrityError, StoreSecurityError } from "./store-errors";

export const sqliteStoreHardCeilings = {
  databaseBytes: 256 * 1024 * 1024,
  deliveryRecordsPerSource: 10_000,
  deliveryRecordsPerTarget: 10_000,
  deliveryRecordsPerWorkspace: deliveryRecordsPerWorkspaceHardCeiling,
  deliveriesPerSourceWindow: 300,
  deliveriesPerTargetWindow: 600,
  deliveriesPerWorkspaceWindow: 3_000,
  retainedEnvelopeBytesPerSource: 32 * 1024 * 1024,
  retainedEnvelopeBytesPerTarget: 64 * 1024 * 1024,
  retainedEnvelopeBytesPerWorkspace: 256 * 1024 * 1024,
  pendingRequestsPerSource: 128,
  pendingRequestsPerTarget: 256,
  pendingRequestsPerWorkspace: pendingRequestsPerWorkspaceHardCeiling,
  pendingRequestBytesPerSource: 4 * 1024 * 1024,
  pendingRequestBytesPerTarget: 8 * 1024 * 1024,
  pendingRequestBytesPerWorkspace: 32 * 1024 * 1024,
  requestsPerSourceWindow: 100,
  requestsPerTargetWindow: 300,
  requestsPerWorkspaceWindow: 1_000,
  retainedResultBytesPerSource: 4 * 1024 * 1024,
  retainedResultBytesPerTarget: 8 * 1024 * 1024,
  retainedResultBytesPerWorkspace: 32 * 1024 * 1024,
  availableResultsPerSource: 512,
  availableResultsPerTarget: 1_024,
  availableResultsPerWorkspace: availableResultsPerWorkspaceHardCeiling,
  requestTraversalNodes: 2_048,
  rateWindowMs: 60_000,
} as const;

export interface SqliteStoreLimits {
  readonly databaseBytes: number;
  readonly deliveryRecordsPerSource: number;
  readonly deliveryRecordsPerTarget: number;
  readonly deliveryRecordsPerWorkspace: number;
  readonly deliveriesPerSourceWindow: number;
  readonly deliveriesPerTargetWindow: number;
  readonly deliveriesPerWorkspaceWindow: number;
  readonly retainedEnvelopeBytesPerSource: number;
  readonly retainedEnvelopeBytesPerTarget: number;
  readonly retainedEnvelopeBytesPerWorkspace: number;
  readonly pendingRequestsPerSource: number;
  readonly pendingRequestsPerTarget: number;
  readonly pendingRequestsPerWorkspace: number;
  /** Retained canonical payload plus verified-envelope UTF-8 bytes for pending source requests. */
  readonly pendingRequestBytesPerSource: number;
  /** Retained canonical payload plus verified-envelope UTF-8 bytes for pending target requests. */
  readonly pendingRequestBytesPerTarget: number;
  /** Retained canonical payload plus verified-envelope UTF-8 bytes for all pending workspace requests. */
  readonly pendingRequestBytesPerWorkspace: number;
  readonly requestsPerSourceWindow: number;
  readonly requestsPerTargetWindow: number;
  readonly requestsPerWorkspaceWindow: number;
  /** Available canonical result bytes retained for requests from one source. */
  readonly retainedResultBytesPerSource: number;
  /** Available canonical result bytes retained for requests to one target. */
  readonly retainedResultBytesPerTarget: number;
  /** Available canonical result bytes retained across the workspace. */
  readonly retainedResultBytesPerWorkspace: number;
  /** Available result rows retained for requests from one source. */
  readonly availableResultsPerSource: number;
  /** Available result rows retained for requests to one target. */
  readonly availableResultsPerTarget: number;
  /** Available result rows retained across the workspace. */
  readonly availableResultsPerWorkspace: number;
  /** Maximum unique wait-graph nodes visited by one admission deadlock check. */
  readonly requestTraversalNodes: number;
  readonly rateWindowMs: number;
}

export const sqliteStoreDefaultLimits: SqliteStoreLimits = {
  databaseBytes: 64 * 1024 * 1024,
  deliveryRecordsPerSource: 1_000,
  deliveryRecordsPerTarget: 1_000,
  deliveryRecordsPerWorkspace: 5_000,
  deliveriesPerSourceWindow: 30,
  deliveriesPerTargetWindow: 60,
  deliveriesPerWorkspaceWindow: 300,
  retainedEnvelopeBytesPerSource: 1 * 1024 * 1024,
  retainedEnvelopeBytesPerTarget: 2 * 1024 * 1024,
  retainedEnvelopeBytesPerWorkspace: 8 * 1024 * 1024,
  pendingRequestsPerSource: 16,
  pendingRequestsPerTarget: 32,
  pendingRequestsPerWorkspace: 128,
  pendingRequestBytesPerSource: 256 * 1024,
  pendingRequestBytesPerTarget: 512 * 1024,
  pendingRequestBytesPerWorkspace: 4 * 1024 * 1024,
  requestsPerSourceWindow: 10,
  requestsPerTargetWindow: 30,
  requestsPerWorkspaceWindow: 100,
  retainedResultBytesPerSource: 256 * 1024,
  retainedResultBytesPerTarget: 512 * 1024,
  retainedResultBytesPerWorkspace: 4 * 1024 * 1024,
  availableResultsPerSource: 64,
  availableResultsPerTarget: 128,
  availableResultsPerWorkspace: 512,
  requestTraversalNodes: 512,
  rateWindowMs: 60_000,
};

export interface LinuxBunSqliteStoreOptions {
  readonly stateDirectory: string;
  readonly workspaceKey: WorkspaceKey;
  /** Diagnostic label only; every store instance creates a distinct process generation. */
  readonly ownerId?: string;
  readonly databaseFileName?: string;
  readonly leaseDurationMs?: number;
  readonly takeoverGraceMs?: number;
  readonly busyTimeoutMs?: number;
  readonly limits?: Partial<SqliteStoreLimits>;
  readonly nowWallMs?: () => number;
  readonly nowMonotonicMs?: () => number;
  /** FUSE is rejected unless the operator has separately validated its SQLite semantics. */
  readonly allowFuseStateFileSystem?: boolean;
  /** Test/fault-injection boundary; production callers should not override this. */
  readonly linuxPathSyscalls?: LinuxPathSyscalls;
  /** Test/fault-injection boundary; production callers should not override this. */
  readonly sqliteDatabaseLifecycle?: SqliteDatabaseLifecycle;
}

export const sqliteStoreDefaultLeaseDurationMs = 15_000;
export const sqliteStoreDefaultTakeoverGraceMs = 1_000;

export interface StoreContext {
  readonly database: Database;
  readonly limits: SqliteStoreLimits;
  readonly workspaceKey: WorkspaceKey;
  readonly ownerGenerationId: string;
  readonly ownerLabel: string;
  readonly leaseDurationMs: number;
  readonly takeoverGraceMs: number;
  readonly nowWallMs: () => number;
  readonly nowMonotonicMs: () => number;
  maximumPageCount: number;
  localToken: FencingToken | undefined;
  localExpiresMonotonicMs: number;
  nextRenewMonotonicMs: number;
  startupBlockedToken: FencingToken | undefined;
}

function boundedInteger(name: keyof SqliteStoreLimits, value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new StoreSecurityError(`${name} is outside its immutable safety ceiling.`);
  }
  return value;
}

export function resolveStoreLimits(input: Partial<SqliteStoreLimits> = {}): SqliteStoreLimits {
  const value = { ...sqliteStoreDefaultLimits, ...input };
  return {
    databaseBytes: boundedInteger(
      "databaseBytes",
      value.databaseBytes,
      sqliteStoreHardCeilings.databaseBytes,
    ),
    deliveryRecordsPerSource: boundedInteger(
      "deliveryRecordsPerSource",
      value.deliveryRecordsPerSource,
      sqliteStoreHardCeilings.deliveryRecordsPerSource,
    ),
    deliveryRecordsPerTarget: boundedInteger(
      "deliveryRecordsPerTarget",
      value.deliveryRecordsPerTarget,
      sqliteStoreHardCeilings.deliveryRecordsPerTarget,
    ),
    deliveryRecordsPerWorkspace: boundedInteger(
      "deliveryRecordsPerWorkspace",
      value.deliveryRecordsPerWorkspace,
      sqliteStoreHardCeilings.deliveryRecordsPerWorkspace,
    ),
    deliveriesPerSourceWindow: boundedInteger(
      "deliveriesPerSourceWindow",
      value.deliveriesPerSourceWindow,
      sqliteStoreHardCeilings.deliveriesPerSourceWindow,
    ),
    deliveriesPerTargetWindow: boundedInteger(
      "deliveriesPerTargetWindow",
      value.deliveriesPerTargetWindow,
      sqliteStoreHardCeilings.deliveriesPerTargetWindow,
    ),
    deliveriesPerWorkspaceWindow: boundedInteger(
      "deliveriesPerWorkspaceWindow",
      value.deliveriesPerWorkspaceWindow,
      sqliteStoreHardCeilings.deliveriesPerWorkspaceWindow,
    ),
    retainedEnvelopeBytesPerSource: boundedInteger(
      "retainedEnvelopeBytesPerSource",
      value.retainedEnvelopeBytesPerSource,
      sqliteStoreHardCeilings.retainedEnvelopeBytesPerSource,
    ),
    retainedEnvelopeBytesPerTarget: boundedInteger(
      "retainedEnvelopeBytesPerTarget",
      value.retainedEnvelopeBytesPerTarget,
      sqliteStoreHardCeilings.retainedEnvelopeBytesPerTarget,
    ),
    retainedEnvelopeBytesPerWorkspace: boundedInteger(
      "retainedEnvelopeBytesPerWorkspace",
      value.retainedEnvelopeBytesPerWorkspace,
      sqliteStoreHardCeilings.retainedEnvelopeBytesPerWorkspace,
    ),
    pendingRequestsPerSource: boundedInteger(
      "pendingRequestsPerSource",
      value.pendingRequestsPerSource,
      sqliteStoreHardCeilings.pendingRequestsPerSource,
    ),
    pendingRequestsPerTarget: boundedInteger(
      "pendingRequestsPerTarget",
      value.pendingRequestsPerTarget,
      sqliteStoreHardCeilings.pendingRequestsPerTarget,
    ),
    pendingRequestsPerWorkspace: boundedInteger(
      "pendingRequestsPerWorkspace",
      value.pendingRequestsPerWorkspace,
      sqliteStoreHardCeilings.pendingRequestsPerWorkspace,
    ),
    pendingRequestBytesPerSource: boundedInteger(
      "pendingRequestBytesPerSource",
      value.pendingRequestBytesPerSource,
      sqliteStoreHardCeilings.pendingRequestBytesPerSource,
    ),
    pendingRequestBytesPerTarget: boundedInteger(
      "pendingRequestBytesPerTarget",
      value.pendingRequestBytesPerTarget,
      sqliteStoreHardCeilings.pendingRequestBytesPerTarget,
    ),
    pendingRequestBytesPerWorkspace: boundedInteger(
      "pendingRequestBytesPerWorkspace",
      value.pendingRequestBytesPerWorkspace,
      sqliteStoreHardCeilings.pendingRequestBytesPerWorkspace,
    ),
    requestsPerSourceWindow: boundedInteger(
      "requestsPerSourceWindow",
      value.requestsPerSourceWindow,
      sqliteStoreHardCeilings.requestsPerSourceWindow,
    ),
    requestsPerTargetWindow: boundedInteger(
      "requestsPerTargetWindow",
      value.requestsPerTargetWindow,
      sqliteStoreHardCeilings.requestsPerTargetWindow,
    ),
    requestsPerWorkspaceWindow: boundedInteger(
      "requestsPerWorkspaceWindow",
      value.requestsPerWorkspaceWindow,
      sqliteStoreHardCeilings.requestsPerWorkspaceWindow,
    ),
    retainedResultBytesPerSource: boundedInteger(
      "retainedResultBytesPerSource",
      value.retainedResultBytesPerSource,
      sqliteStoreHardCeilings.retainedResultBytesPerSource,
    ),
    retainedResultBytesPerTarget: boundedInteger(
      "retainedResultBytesPerTarget",
      value.retainedResultBytesPerTarget,
      sqliteStoreHardCeilings.retainedResultBytesPerTarget,
    ),
    retainedResultBytesPerWorkspace: boundedInteger(
      "retainedResultBytesPerWorkspace",
      value.retainedResultBytesPerWorkspace,
      sqliteStoreHardCeilings.retainedResultBytesPerWorkspace,
    ),
    availableResultsPerSource: boundedInteger(
      "availableResultsPerSource",
      value.availableResultsPerSource,
      sqliteStoreHardCeilings.availableResultsPerSource,
    ),
    availableResultsPerTarget: boundedInteger(
      "availableResultsPerTarget",
      value.availableResultsPerTarget,
      sqliteStoreHardCeilings.availableResultsPerTarget,
    ),
    availableResultsPerWorkspace: boundedInteger(
      "availableResultsPerWorkspace",
      value.availableResultsPerWorkspace,
      sqliteStoreHardCeilings.availableResultsPerWorkspace,
    ),
    requestTraversalNodes: boundedInteger(
      "requestTraversalNodes",
      value.requestTraversalNodes,
      sqliteStoreHardCeilings.requestTraversalNodes,
    ),
    rateWindowMs: boundedInteger(
      "rateWindowMs",
      value.rateWindowMs,
      sqliteStoreHardCeilings.rateWindowMs,
    ),
  };
}
