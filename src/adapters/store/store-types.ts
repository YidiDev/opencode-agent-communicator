import type { Database } from "bun:sqlite";

import { type FencingToken, OwnershipLostFault } from "../../domain/ownership";
import type { WorkspaceKey } from "../../domain/workspaces";

export interface LinuxFileStat {
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  readonly nlink: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

/** Narrow injectable boundary used by race and failure tests. */
export interface LinuxPathSyscalls {
  readonly open: (path: string, flags: number, mode?: number) => number;
  readonly close: (descriptor: number) => void;
  readonly mkdir: (path: string, mode: number) => void;
  readonly fstat: (descriptor: number) => LinuxFileStat;
  readonly fchmod: (descriptor: number, mode: number) => void;
  readonly statfsType: (descriptorPath: string) => bigint;
  readonly uid: () => number | undefined;
}

/** Minimal injectable boundary for deterministic database open/close failure tests. */
export interface SqliteDatabaseLifecycle {
  readonly open: (path: string, flags: number) => Database;
  readonly close: (database: Database) => void;
}

export const sqliteStoreHardCeilings = {
  databaseBytes: 256 * 1024 * 1024,
  deliveryRecordsPerSource: 10_000,
  deliveryRecordsPerTarget: 10_000,
  deliveryRecordsPerWorkspace: 50_000,
  deliveriesPerSourceWindow: 300,
  deliveriesPerTargetWindow: 600,
  deliveriesPerWorkspaceWindow: 3_000,
  retainedEnvelopeBytesPerSource: 32 * 1024 * 1024,
  retainedEnvelopeBytesPerTarget: 64 * 1024 * 1024,
  retainedEnvelopeBytesPerWorkspace: 256 * 1024 * 1024,
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

export class StoreSecurityError extends Error {
  override readonly name = "StoreSecurityError";
}

export class StoreIntegrityError extends Error {
  override readonly name = "StoreIntegrityError";
}

export class OwnershipUnavailableError extends OwnershipLostFault {
  override readonly name = "OwnershipUnavailableError";
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
    rateWindowMs: boundedInteger(
      "rateWindowMs",
      value.rateWindowMs,
      sqliteStoreHardCeilings.rateWindowMs,
    ),
  };
}
