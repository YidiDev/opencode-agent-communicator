import type {
  AdvisoryLockCursor,
  AdvisoryLockExpirySchedule,
  AdvisoryLockListResult,
} from "../../application/advisory-lock-ports";
import {
  type AdvisoryLock,
  advisoryLockPolicy,
  isCoherentAdvisoryLock,
} from "../../domain/advisory-locks";
import { validateAdvisoryLockId } from "../../domain/generated-ids";
import type { WorkspaceKey } from "../../domain/workspaces";
import { requestStoreNowMs } from "./request-repository-shared";
import { type StoreContext, StoreIntegrityError } from "./store-types";

interface AdvisoryLockRow {
  readonly lockId: unknown;
  readonly holderSessionId: unknown;
  readonly title: unknown;
  readonly description: unknown;
  readonly instructions: unknown;
  readonly createdAtMs: unknown;
  readonly renewedAtMs: unknown;
  readonly expiresAtMs: unknown;
}

const columns = `lock_id AS lockId, holder_session_id AS holderSessionId, title,
  description, instructions, created_at_ms AS createdAtMs, renewed_at_ms AS renewedAtMs,
  expires_at_ms AS expiresAtMs`;

export function hydrateAdvisoryLock(row: AdvisoryLockRow): AdvisoryLock {
  const lock = {
    lockId: row.lockId,
    holderSessionId: row.holderSessionId,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    createdAtMs: row.createdAtMs,
    renewedAtMs: row.renewedAtMs,
    expiresAtMs: row.expiresAtMs,
  };
  if (!isCoherentAdvisoryLock(lock)) {
    throw new StoreIntegrityError("Stored advisory lock metadata is malformed.");
  }
  return Object.freeze(lock);
}

export function listActiveAdvisoryLocks(
  context: StoreContext,
  input: {
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
    readonly cursor?: AdvisoryLockCursor;
  },
): AdvisoryLockListResult {
  assertListInput(context, input);
  const storeNowMs = requestStoreNowMs(context);
  const rows = input.cursor
    ? context.database
        .query<AdvisoryLockRow, [string, number, number, string, number]>(
          `SELECT ${columns} FROM advisory_locks INDEXED BY advisory_locks_list_v13
           WHERE workspace_key = ? AND expires_at_ms > ?
             AND (created_at_ms, lock_id) < (?, ?)
           ORDER BY created_at_ms DESC, lock_id DESC LIMIT ?`,
        )
        .all(
          input.workspaceKey,
          storeNowMs,
          input.cursor.createdAtMs,
          input.cursor.lockId,
          input.limit,
        )
    : context.database
        .query<AdvisoryLockRow, [string, number, number]>(
          `SELECT ${columns} FROM advisory_locks INDEXED BY advisory_locks_list_v13
           WHERE workspace_key = ? AND expires_at_ms > ?
           ORDER BY created_at_ms DESC, lock_id DESC LIMIT ?`,
        )
        .all(input.workspaceKey, storeNowMs, input.limit);
  const locks = rows.map(hydrateAdvisoryLock);
  const last = locks.at(-1);
  return Object.freeze({
    locks: Object.freeze(locks),
    ...(last && locks.length === input.limit
      ? { nextCursor: Object.freeze({ createdAtMs: last.createdAtMs, lockId: last.lockId }) }
      : {}),
  });
}

export function selectAdvisoryLock(
  context: StoreContext,
  workspaceKey: string,
  lockId: string,
): AdvisoryLock | undefined {
  const row = context.database
    .query<AdvisoryLockRow, [string, string]>(
      `SELECT ${columns} FROM advisory_locks WHERE workspace_key = ? AND lock_id = ?`,
    )
    .get(workspaceKey, lockId);
  return row ? hydrateAdvisoryLock(row) : undefined;
}

export function selectOwnedActiveAdvisoryLock(
  context: StoreContext,
  workspaceKey: string,
  lockId: string,
  holderSessionId: string,
  storeNowMs: number,
): AdvisoryLock | undefined {
  const row = context.database
    .query<AdvisoryLockRow, [string, string, string, number]>(
      `SELECT ${columns} FROM advisory_locks
       WHERE workspace_key = ? AND lock_id = ? AND holder_session_id = ?
         AND expires_at_ms > ?`,
    )
    .get(workspaceKey, lockId, holderSessionId, storeNowMs);
  return row ? hydrateAdvisoryLock(row) : undefined;
}

export function readAdvisoryLockExpirySchedule(
  context: StoreContext,
  workspaceKey: WorkspaceKey,
): AdvisoryLockExpirySchedule {
  if (workspaceKey !== context.workspaceKey) {
    throw new StoreIntegrityError("The advisory lock schedule workspace is invalid.");
  }
  const storeObservedAtMs = requestStoreNowMs(context);
  const row = context.database
    .query<{ readonly expiresAtMs: unknown }, [string, number]>(
      `SELECT expires_at_ms AS expiresAtMs FROM advisory_locks
       WHERE workspace_key = ? AND expires_at_ms > ?
       ORDER BY expires_at_ms, lock_id LIMIT 1`,
    )
    .get(workspaceKey, storeObservedAtMs);
  if (row && (!Number.isSafeInteger(row.expiresAtMs) || (row.expiresAtMs as number) < 0)) {
    throw new StoreIntegrityError("The advisory lock expiry schedule was malformed.");
  }
  return Object.freeze({
    storeObservedAtMs,
    maximumSleepMs: Math.floor(context.leaseDurationMs / 3),
    ...(row ? { nextExpiryAtMs: row.expiresAtMs as number } : {}),
  });
}

function assertListInput(
  context: StoreContext,
  input: {
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
    readonly cursor?: AdvisoryLockCursor;
  },
): void {
  if (
    input.workspaceKey !== context.workspaceKey ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > advisoryLockPolicy.maximumListLimit ||
    (input.cursor !== undefined &&
      (!Number.isSafeInteger(input.cursor.createdAtMs) ||
        input.cursor.createdAtMs < 0 ||
        !validateAdvisoryLockId(input.cursor.lockId).ok))
  ) {
    throw new StoreIntegrityError("The advisory lock list input is malformed.");
  }
}
