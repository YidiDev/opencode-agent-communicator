import type { OperationControl, StartupRecoveryBarrier } from "../../application/delivery-ports";
import { type FencingToken, OwnershipLostFault } from "../../domain/ownership";
import { OwnershipUnavailableError, type StoreContext, StoreIntegrityError } from "./store-types";

interface OwnershipRow {
  readonly ownerGenerationId: string;
  readonly fencingToken: number;
  readonly expiresWallMs: number;
  readonly releasedWallMs: number | null;
}

interface CountRow {
  readonly count: number;
}

const ownershipSql = `SELECT owner_id AS ownerGenerationId, fencing_token AS fencingToken,
  expires_wall_ms AS expiresWallMs, released_wall_ms AS releasedWallMs
  FROM ownership WHERE singleton = 1`;

function currentRow(context: StoreContext): OwnershipRow | undefined {
  const row = context.database.query<OwnershipRow, []>(ownershipSql).get() ?? undefined;
  if (row && !validRow(row)) {
    throw new StoreIntegrityError("Stored ownership metadata is malformed.");
  }
  return row;
}

function validRow(row: OwnershipRow): boolean {
  return (
    typeof row.ownerGenerationId === "string" &&
    Number.isSafeInteger(row.fencingToken) &&
    row.fencingToken >= 1 &&
    Number.isSafeInteger(row.expiresWallMs) &&
    (row.releasedWallMs === null || Number.isSafeInteger(row.releasedWallMs))
  );
}

export class OwnershipRepository {
  private readonly barriers = new WeakSet<object>();

  constructor(private readonly context: StoreContext) {}

  acquire(): FencingToken {
    const acquire = this.context.database.transaction(() => {
      const nowWallMs = this.context.nowWallMs();
      const row = currentRow(this.context);
      let token: number;
      if (!row) {
        token = 1;
        this.context.database.run(
          `INSERT INTO ownership(singleton, owner_id, fencing_token, acquired_wall_ms,
             renewed_wall_ms, expires_wall_ms, owner_label, released_wall_ms)
           VALUES (1, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            this.context.ownerGenerationId,
            token,
            nowWallMs,
            nowWallMs,
            nowWallMs + this.context.leaseDurationMs,
            this.context.ownerLabel,
          ],
        );
      } else {
        if (
          row.ownerGenerationId === this.context.ownerGenerationId &&
          this.context.localToken === row.fencingToken &&
          this.context.nowMonotonicMs() < this.context.localExpiresMonotonicMs &&
          row.releasedWallMs === null &&
          row.expiresWallMs > nowWallMs
        ) {
          token = row.fencingToken;
        } else {
          if (
            row.releasedWallMs === null &&
            row.expiresWallMs + this.context.takeoverGraceMs > nowWallMs
          ) {
            throw new OwnershipUnavailableError("SQLite ownership is held by another backend.");
          }
          if (row.fencingToken >= Number.MAX_SAFE_INTEGER) {
            throw new StoreIntegrityError("The SQLite fencing epoch is exhausted.");
          }
          token = row.fencingToken + 1;
        }
        const changed = this.context.database.run(
          `UPDATE ownership SET owner_id = ?, owner_label = ?, fencing_token = ?,
             acquired_wall_ms = CASE
               WHEN fencing_token = ? AND owner_id = ? THEN acquired_wall_ms ELSE ? END,
             renewed_wall_ms = ?, expires_wall_ms = ?, released_wall_ms = NULL
           WHERE singleton = 1 AND fencing_token = ? AND owner_id = ?`,
          [
            this.context.ownerGenerationId,
            this.context.ownerLabel,
            token,
            token,
            this.context.ownerGenerationId,
            nowWallMs,
            nowWallMs,
            nowWallMs + this.context.leaseDurationMs,
            row.fencingToken,
            row.ownerGenerationId,
          ],
        );
        if (changed.changes !== 1) throw new OwnershipUnavailableError("Ownership changed.");
      }
      return token as FencingToken;
    });
    const token = acquire.immediate();
    const monotonic = this.context.nowMonotonicMs();
    this.context.localToken = token;
    this.context.localExpiresMonotonicMs = monotonic + this.context.leaseDurationMs;
    this.context.nextRenewMonotonicMs = monotonic + Math.floor(this.context.leaseDurationMs / 3);
    const stale = this.context.database
      .query<CountRow, [string, number]>(
        `SELECT count(*) AS count FROM deliveries
         WHERE workspace_key = ? AND state = 'submitting' AND claimed_fencing_token != ?`,
      )
      .get(this.context.workspaceKey, token);
    if (!stale || !Number.isSafeInteger(stale.count) || stale.count < 0) {
      throw new StoreIntegrityError("The startup recovery aggregate was malformed.");
    }
    this.context.startupBlockedToken = stale.count > 0 ? token : undefined;
    return token;
  }

  isCurrent(token: FencingToken): boolean {
    if (this.context.localToken !== token) return false;
    const monotonic = this.context.nowMonotonicMs();
    if (monotonic >= this.context.localExpiresMonotonicMs) return false;
    const wall = this.context.nowWallMs();
    const row = currentRow(this.context);
    if (
      !row ||
      row.ownerGenerationId !== this.context.ownerGenerationId ||
      row.fencingToken !== token ||
      row.releasedWallMs !== null
    ) {
      return false;
    }
    if (row.expiresWallMs <= wall) return false;
    if (monotonic < this.context.nextRenewMonotonicMs) return true;
    const changed = this.context.database.run(
      `UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ?
       WHERE singleton = 1 AND owner_id = ? AND fencing_token = ?
         AND released_wall_ms IS NULL AND expires_wall_ms > ?`,
      [wall, wall + this.context.leaseDurationMs, this.context.ownerGenerationId, token, wall],
    );
    if (changed.changes !== 1) return false;
    this.context.localExpiresMonotonicMs = monotonic + this.context.leaseDurationMs;
    this.context.nextRenewMonotonicMs = monotonic + Math.floor(this.context.leaseDurationMs / 3);
    return true;
  }

  assertCurrent(token: FencingToken): void {
    if (!this.isCurrent(token)) throw new OwnershipLostFault("SQLite ownership was lost.");
  }

  assertImplicitCurrent(): FencingToken {
    const token = this.context.localToken;
    if (token === undefined || !this.isCurrent(token)) {
      throw new OwnershipLostFault("SQLite ownership was lost.");
    }
    return token;
  }

  /** Read-only close-path check. It must never renew a lease. */
  hasCurrentLease(): boolean {
    const token = this.context.localToken;
    if (token === undefined) return false;
    if (this.context.nowMonotonicMs() >= this.context.localExpiresMonotonicMs) return false;
    const wall = this.context.nowWallMs();
    const row = currentRow(this.context);
    return (
      row?.ownerGenerationId === this.context.ownerGenerationId &&
      row.fencingToken === token &&
      row.releasedWallMs === null &&
      row.expiresWallMs > wall
    );
  }

  assertOrdinaryWorkAllowed(token: FencingToken): void {
    this.assertCurrent(token);
    if (this.context.startupBlockedToken === token) {
      throw new OwnershipLostFault("Startup recovery must classify stale submissions first.");
    }
  }

  markStaleClassificationProgress(token: FencingToken): void {
    if (this.context.startupBlockedToken !== token) return;
    const stale = this.context.database
      .query<CountRow, [string, number]>(
        `SELECT count(*) AS count FROM deliveries
         WHERE workspace_key = ? AND state = 'submitting' AND claimed_fencing_token != ?`,
      )
      .get(this.context.workspaceKey, token);
    if (!stale || !Number.isSafeInteger(stale.count)) {
      throw new StoreIntegrityError("The startup recovery aggregate was malformed.");
    }
    if (stale.count === 0) this.context.startupBlockedToken = undefined;
  }

  establish(token: FencingToken, control: OperationControl): StartupRecoveryBarrier {
    if (
      control.abort.aborted ||
      (control.deadlineMs !== undefined && this.context.nowWallMs() >= control.deadlineMs)
    ) {
      throw new OwnershipLostFault("Startup recovery was cancelled before its ownership barrier.");
    }
    this.assertCurrent(token);
    const barrier: StartupRecoveryBarrier = Object.freeze({
      established: true,
      fencingToken: token,
    });
    this.barriers.add(barrier);
    return barrier;
  }

  assertBarrier(barrier: StartupRecoveryBarrier, token: FencingToken): void {
    if (!this.barriers.has(barrier) || barrier.fencingToken !== token) {
      throw new OwnershipLostFault("A valid startup recovery barrier is required.");
    }
    this.assertCurrent(token);
  }

  relinquish(): void {
    const token = this.context.localToken;
    if (token === undefined || !this.hasCurrentLease()) return;
    const releasedWallMs = this.context.nowWallMs();
    const release = this.context.database.transaction(() => {
      const changed = this.context.database.run(
        `UPDATE ownership SET released_wall_ms = ?
         WHERE singleton = 1 AND owner_id = ? AND fencing_token = ?
           AND released_wall_ms IS NULL`,
        [releasedWallMs, this.context.ownerGenerationId, token],
      );
      if (changed.changes !== 1) throw new OwnershipLostFault("SQLite ownership was lost.");
    });
    release.immediate();
    this.context.localToken = undefined;
    this.context.startupBlockedToken = undefined;
  }
}
