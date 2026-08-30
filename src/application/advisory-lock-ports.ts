import type { AdvisoryLock } from "../domain/advisory-locks";
import type { AdvisoryLockId } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";

export type AdvisoryLockStoreFailureCode =
  | "quota_exceeded"
  | "not_found_or_unauthorized"
  | "ownership_lost"
  | "state_conflict"
  | "storage_unavailable";

export type AdvisoryLockMutationResult =
  | { readonly ok: true; readonly lock: AdvisoryLock }
  | { readonly ok: false; readonly code: AdvisoryLockStoreFailureCode };

export interface AdvisoryLockCursor {
  readonly createdAtMs: number;
  readonly lockId: AdvisoryLockId;
}

export interface AdvisoryLockListResult {
  readonly locks: readonly AdvisoryLock[];
  readonly nextCursor?: AdvisoryLockCursor;
}

export interface AdvisoryLockExpirySchedule {
  readonly storeObservedAtMs: number;
  readonly maximumSleepMs: number;
  readonly nextExpiryAtMs?: number;
}

export interface AdvisoryLockPersistencePort {
  publish(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly lockId: AdvisoryLockId;
    readonly holderSessionId: SessionId;
    readonly title: string;
    readonly description: string;
    readonly instructions: string;
    readonly ttlSeconds: number;
  }): Promise<AdvisoryLockMutationResult>;
  list(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
    readonly cursor?: AdvisoryLockCursor;
  }): Promise<AdvisoryLockListResult>;
  renew(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly lockId: AdvisoryLockId;
    readonly holderSessionId: SessionId;
    readonly ttlSeconds: number;
  }): Promise<AdvisoryLockMutationResult>;
  release(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly lockId: AdvisoryLockId;
    readonly holderSessionId: SessionId;
  }): Promise<AdvisoryLockMutationResult>;
  cleanupExpired(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<{ readonly deleted: number }>;
  readNextExpiry(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
  }): Promise<AdvisoryLockExpirySchedule>;
}
