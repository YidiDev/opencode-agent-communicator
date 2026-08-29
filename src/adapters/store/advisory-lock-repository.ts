import type {
  AdvisoryLockCursor,
  AdvisoryLockExpirySchedule,
  AdvisoryLockListResult,
  AdvisoryLockMutationResult,
} from "../../application/advisory-lock-ports";
import {
  type AdvisoryLock,
  advisoryLockPolicy,
  isCoherentAdvisoryLock,
  validateAdvisoryLockDescription,
  validateAdvisoryLockInstructions,
  validateAdvisoryLockTitle,
  validateAdvisoryLockTtlSeconds,
} from "../../domain/advisory-locks";
import { type AdvisoryLockId, validateAdvisoryLockId } from "../../domain/generated-ids";
import type { FencingToken } from "../../domain/ownership";
import { OwnershipLostFault } from "../../domain/ownership";
import { activeAdvisoryLocksPerWorkspaceHardCeiling } from "../../domain/safety-ceilings";
import { type SessionId, validateSessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import { classifyDeliveryStorageError } from "./delivery-repository";
import type { OwnershipRepository } from "./ownership-repository";
import { requestPageLimitReached, requestStoreNowMs } from "./request-repository-shared";
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

function hydrate(row: AdvisoryLockRow): AdvisoryLock {
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

function failure(cause: unknown, atPageLimit: boolean): AdvisoryLockMutationResult {
  const classified = classifyDeliveryStorageError(cause, () => atPageLimit);
  return {
    ok: false,
    code:
      cause instanceof OwnershipLostFault
        ? "ownership_lost"
        : classified === "rate_limited"
          ? "storage_unavailable"
          : classified,
  };
}

export class AdvisoryLockRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  publish(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly lockId: AdvisoryLockId;
    readonly holderSessionId: SessionId;
    readonly title: string;
    readonly description: string;
    readonly instructions: string;
    readonly ttlSeconds: number;
  }): AdvisoryLockMutationResult {
    if (
      !this.validWorkspace(input.workspaceKey) ||
      !validateAdvisoryLockId(input.lockId).ok ||
      !validateSessionId(input.holderSessionId).ok ||
      !validateAdvisoryLockTitle(input.title).ok ||
      !validateAdvisoryLockDescription(input.description).ok ||
      !validateAdvisoryLockInstructions(input.instructions).ok ||
      !validateAdvisoryLockTtlSeconds(input.ttlSeconds).ok
    ) {
      return { ok: false, code: "state_conflict" };
    }
    const atPageLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const storeNowMs = requestStoreNowMs(this.context);
        const expiresAtMs = storeNowMs + input.ttlSeconds * 1_000;
        if (!Number.isSafeInteger(expiresAtMs)) {
          return { ok: false as const, code: "state_conflict" as const };
        }
        this.context.database.run(
          `DELETE FROM advisory_locks WHERE lock_id IN (
             SELECT lock_id FROM advisory_locks
             WHERE workspace_key = ? AND expires_at_ms <= ?
             ORDER BY expires_at_ms, lock_id LIMIT ?
           )`,
          [input.workspaceKey, storeNowMs, activeAdvisoryLocksPerWorkspaceHardCeiling],
        );
        const count = this.context.database
          .query<{ readonly count: number }, [string]>(
            "SELECT count(*) AS count FROM advisory_locks WHERE workspace_key = ?",
          )
          .get(input.workspaceKey)?.count;
        if (!Number.isSafeInteger(count) || (count as number) < 0) {
          throw new StoreIntegrityError("The advisory lock quota aggregate was malformed.");
        }
        if ((count as number) >= activeAdvisoryLocksPerWorkspaceHardCeiling) {
          return { ok: false as const, code: "quota_exceeded" as const };
        }
        this.context.database.run(
          "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES (?, ?)",
          [input.workspaceKey, storeNowMs],
        );
        this.context.database.run(
          `INSERT INTO advisory_locks(lock_id, workspace_key, holder_session_id, title,
             description, instructions, created_at_ms, renewed_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.lockId,
            input.workspaceKey,
            input.holderSessionId,
            input.title,
            input.description,
            input.instructions,
            storeNowMs,
            storeNowMs,
            expiresAtMs,
          ],
        );
        return {
          ok: true as const,
          lock: hydrate({
            lockId: input.lockId,
            holderSessionId: input.holderSessionId,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            createdAtMs: storeNowMs,
            renewedAtMs: storeNowMs,
            expiresAtMs,
          }),
        };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return failure(cause, atPageLimit);
    }
  }

  list(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
    readonly cursor?: AdvisoryLockCursor;
  }): AdvisoryLockListResult {
    const transaction = this.context.database.transaction(() => {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      this.assertListInput(input.workspaceKey, input.limit, input.cursor);
      const storeNowMs = requestStoreNowMs(this.context);
      const rows = input.cursor
        ? this.context.database
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
        : this.context.database
            .query<AdvisoryLockRow, [string, number, number]>(
              `SELECT ${columns} FROM advisory_locks INDEXED BY advisory_locks_list_v13
               WHERE workspace_key = ? AND expires_at_ms > ?
               ORDER BY created_at_ms DESC, lock_id DESC LIMIT ?`,
            )
            .all(input.workspaceKey, storeNowMs, input.limit);
      const locks = rows.map(hydrate);
      const last = locks.at(-1);
      return Object.freeze({
        locks: Object.freeze(locks),
        ...(last && locks.length === input.limit
          ? { nextCursor: Object.freeze({ createdAtMs: last.createdAtMs, lockId: last.lockId }) }
          : {}),
      });
    });
    return transaction.immediate();
  }

  renew(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly lockId: AdvisoryLockId;
    readonly holderSessionId: SessionId;
    readonly ttlSeconds: number;
  }): AdvisoryLockMutationResult {
    if (
      !this.validMutationIdentity(input) ||
      !validateAdvisoryLockTtlSeconds(input.ttlSeconds).ok
    ) {
      return { ok: false, code: "state_conflict" };
    }
    return this.updateOwned(input, (storeNowMs) => {
      const expiresAtMs = storeNowMs + input.ttlSeconds * 1_000;
      if (!Number.isSafeInteger(expiresAtMs)) return undefined;
      const changed = this.context.database.run(
        `UPDATE advisory_locks SET renewed_at_ms = ?, expires_at_ms = ?
         WHERE workspace_key = ? AND lock_id = ? AND holder_session_id = ?
           AND expires_at_ms > ?`,
        [
          storeNowMs,
          expiresAtMs,
          input.workspaceKey,
          input.lockId,
          input.holderSessionId,
          storeNowMs,
        ],
      );
      return changed.changes === 1 ? this.select(input.workspaceKey, input.lockId) : undefined;
    });
  }

  release(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly lockId: AdvisoryLockId;
    readonly holderSessionId: SessionId;
  }): AdvisoryLockMutationResult {
    if (!this.validMutationIdentity(input)) return { ok: false, code: "state_conflict" };
    return this.updateOwned(input, (storeNowMs) => {
      const lock = this.context.database
        .query<AdvisoryLockRow, [string, string, string, number]>(
          `SELECT ${columns} FROM advisory_locks
           WHERE workspace_key = ? AND lock_id = ? AND holder_session_id = ?
             AND expires_at_ms > ?`,
        )
        .get(input.workspaceKey, input.lockId, input.holderSessionId, storeNowMs);
      if (!lock) return undefined;
      const deleted = this.context.database.run(
        `DELETE FROM advisory_locks WHERE workspace_key = ? AND lock_id = ?
           AND holder_session_id = ? AND expires_at_ms > ?`,
        [input.workspaceKey, input.lockId, input.holderSessionId, storeNowMs],
      );
      if (deleted.changes !== 1) return undefined;
      return hydrate(lock);
    });
  }

  cleanupExpired(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): { readonly deleted: number } {
    const transaction = this.context.database.transaction(() => {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      if (
        !this.validWorkspace(input.workspaceKey) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > advisoryLockPolicy.maximumCleanupLimit
      ) {
        throw new StoreIntegrityError("The advisory lock cleanup input is malformed.");
      }
      const storeNowMs = requestStoreNowMs(this.context);
      const result = this.context.database.run(
        `DELETE FROM advisory_locks WHERE lock_id IN (
           SELECT lock_id FROM advisory_locks INDEXED BY advisory_locks_expiry_v13
           WHERE workspace_key = ? AND expires_at_ms <= ?
           ORDER BY expires_at_ms, lock_id LIMIT ?
         )`,
        [input.workspaceKey, storeNowMs, input.limit],
      );
      return Object.freeze({ deleted: result.changes });
    });
    return transaction.immediate();
  }

  readNextExpiry(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
  }): AdvisoryLockExpirySchedule {
    const transaction = this.context.database.transaction(() => {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      if (!this.validWorkspace(input.workspaceKey)) {
        throw new StoreIntegrityError("The advisory lock schedule workspace is invalid.");
      }
      const storeObservedAtMs = requestStoreNowMs(this.context);
      const row = this.context.database
        .query<{ readonly expiresAtMs: unknown }, [string, number]>(
          `SELECT expires_at_ms AS expiresAtMs FROM advisory_locks
           WHERE workspace_key = ? AND expires_at_ms > ?
           ORDER BY expires_at_ms, lock_id LIMIT 1`,
        )
        .get(input.workspaceKey, storeObservedAtMs);
      if (row && (!Number.isSafeInteger(row.expiresAtMs) || (row.expiresAtMs as number) < 0)) {
        throw new StoreIntegrityError("The advisory lock expiry schedule was malformed.");
      }
      return Object.freeze({
        storeObservedAtMs,
        maximumSleepMs: Math.floor(this.context.leaseDurationMs / 3),
        ...(row ? { nextExpiryAtMs: row.expiresAtMs as number } : {}),
      });
    });
    return transaction.immediate();
  }

  private updateOwned(
    input: { readonly fencingToken: FencingToken },
    operation: (storeNowMs: number) => AdvisoryLock | undefined,
  ): AdvisoryLockMutationResult {
    const atPageLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const lock = operation(requestStoreNowMs(this.context));
        return lock
          ? { ok: true as const, lock }
          : { ok: false as const, code: "not_found_or_unauthorized" as const };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return failure(cause, atPageLimit);
    }
  }

  private select(workspaceKey: string, lockId: string): AdvisoryLock | undefined {
    const row = this.context.database
      .query<AdvisoryLockRow, [string, string]>(
        `SELECT ${columns} FROM advisory_locks WHERE workspace_key = ? AND lock_id = ?`,
      )
      .get(workspaceKey, lockId);
    return row ? hydrate(row) : undefined;
  }

  private validWorkspace(workspaceKey: string): boolean {
    return workspaceKey === this.context.workspaceKey;
  }

  private validMutationIdentity(input: {
    readonly workspaceKey: string;
    readonly lockId: string;
    readonly holderSessionId: string;
  }): boolean {
    return (
      this.validWorkspace(input.workspaceKey) &&
      validateAdvisoryLockId(input.lockId).ok &&
      validateSessionId(input.holderSessionId).ok
    );
  }

  private assertListInput(
    workspaceKey: string,
    limit: number,
    cursor: AdvisoryLockCursor | undefined,
  ): void {
    if (
      !this.validWorkspace(workspaceKey) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > advisoryLockPolicy.maximumListLimit ||
      (cursor !== undefined &&
        (!Number.isSafeInteger(cursor.createdAtMs) ||
          cursor.createdAtMs < 0 ||
          !validateAdvisoryLockId(cursor.lockId).ok))
    ) {
      throw new StoreIntegrityError("The advisory lock list input is malformed.");
    }
  }
}
