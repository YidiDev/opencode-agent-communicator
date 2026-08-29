import type { AdvisoryLock } from "../domain/advisory-locks";
import type { AdvisoryLockId, AdvisoryLockIdFactory } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorReadinessPort } from "./communicator-readiness-port";
import type { CurrentWorkspaceMembershipPort } from "./delivery-ports";

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

export interface AdvisoryLockNotificationSummary {
  readonly eligible: number;
  readonly admitted: number;
  readonly unknown: number;
}

export type AdvisoryLockMutationKind = "published" | "renewed" | "released";

export interface AdvisoryLockPostCommitNotificationPort {
  notifyAdvisoryLockMutation(input: {
    readonly workspaceKey: WorkspaceKey;
    readonly holderSessionId: SessionId;
    readonly kind: AdvisoryLockMutationKind;
    readonly lock: AdvisoryLock;
  }): Promise<AdvisoryLockNotificationSummary>;
}

export interface AdvisoryLockWakePort {
  wakeAdvisoryLockExpiry(): void;
}

export interface AdvisoryLockUseCasePorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly locks: AdvisoryLockPersistencePort;
  readonly wake?: AdvisoryLockWakePort;
  readonly notifications?: AdvisoryLockPostCommitNotificationPort;
  readonly ids?: AdvisoryLockIdFactory;
}

export interface AdvisoryLockUseCaseContext {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: FencingToken;
  readonly callerSessionId: unknown;
}

export interface AdvisoryLockMutationValue {
  readonly lock: AdvisoryLock;
  readonly notification: AdvisoryLockNotificationSummary;
}

export interface AdvisoryLockListValue {
  readonly locks: readonly AdvisoryLock[];
  readonly nextCursor?: string;
}
