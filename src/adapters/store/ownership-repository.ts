import type { OperationControl, StartupRecoveryBarrier } from "../../application/delivery-ports";
import { type FencingToken, OwnershipLostFault } from "../../domain/ownership";
import { OwnershipUnavailableError, type StoreContext, StoreIntegrityError } from "./store-types";

interface OwnershipRow {
  readonly ownerGenerationId: string;
  readonly fencingToken: number;
  readonly acquiredWallMs: number;
  readonly renewedWallMs: number;
  readonly expiresWallMs: number;
  readonly releasedWallMs: number | null;
}

interface CountRow {
  readonly count: number;
}

const ownershipSql = `SELECT owner_id AS ownerGenerationId, fencing_token AS fencingToken,
  acquired_wall_ms AS acquiredWallMs, renewed_wall_ms AS renewedWallMs,
  expires_wall_ms AS expiresWallMs, released_wall_ms AS releasedWallMs
  FROM ownership WHERE singleton = 1`;

function wallTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreIntegrityError("The ownership wall clock is outside its safe range.");
  }
  return value;
}

function leaseEnd(startWallMs: number, leaseDurationMs: number): number {
  const endWallMs = startWallMs + leaseDurationMs;
  if (!Number.isSafeInteger(endWallMs)) {
    throw new StoreIntegrityError("The ownership lease timing exceeds its safe range.");
  }
  return endWallMs;
}

function localLeaseSchedule(nowMonotonicMs: number, leaseDurationMs: number) {
  const expiresMonotonicMs = nowMonotonicMs + leaseDurationMs;
  const nextRenewMonotonicMs = nowMonotonicMs + Math.floor(leaseDurationMs / 3);
  if (
    !Number.isFinite(nowMonotonicMs) ||
    nowMonotonicMs < 0 ||
    expiresMonotonicMs > Number.MAX_SAFE_INTEGER
  ) {
    throw new StoreIntegrityError("The ownership monotonic clock is outside its safe range.");
  }
  return { expiresMonotonicMs, nextRenewMonotonicMs };
}

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
    Number.isSafeInteger(row.acquiredWallMs) &&
    row.acquiredWallMs >= 0 &&
    Number.isSafeInteger(row.renewedWallMs) &&
    row.renewedWallMs >= row.acquiredWallMs &&
    Number.isSafeInteger(row.expiresWallMs) &&
    row.expiresWallMs > row.renewedWallMs &&
    (row.releasedWallMs === null ||
      (Number.isSafeInteger(row.releasedWallMs) &&
        row.releasedWallMs >= row.acquiredWallMs &&
        row.releasedWallMs <= row.expiresWallMs))
  );
}

function acquisitionEpoch(
  context: StoreContext,
  row: OwnershipRow,
  nowWallMs: number,
): { readonly token: number; readonly isSameLiveLease: boolean } {
  const isSameLiveLease =
    row.ownerGenerationId === context.ownerGenerationId &&
    context.localToken === row.fencingToken &&
    context.nowMonotonicMs() < context.localExpiresMonotonicMs &&
    row.releasedWallMs === null &&
    row.expiresWallMs > nowWallMs;
  if (isSameLiveLease) return { token: row.fencingToken, isSameLiveLease };
  const takeoverWallMs = leaseEnd(row.expiresWallMs, context.takeoverGraceMs);
  if (row.releasedWallMs === null && takeoverWallMs > nowWallMs) {
    throw new OwnershipUnavailableError("SQLite ownership is held by another backend.");
  }
  if (row.fencingToken >= Number.MAX_SAFE_INTEGER) {
    throw new StoreIntegrityError("The SQLite fencing epoch is exhausted.");
  }
  return { token: row.fencingToken + 1, isSameLiveLease };
}

export class OwnershipRepository {
  private readonly barriers = new WeakSet<object>();

  constructor(private readonly context: StoreContext) {}

  acquire(): FencingToken {
    const schedule = localLeaseSchedule(
      this.context.nowMonotonicMs(),
      this.context.leaseDurationMs,
    );
    const acquire = this.context.database.transaction(() => {
      const nowWallMs = wallTimestamp(this.context.nowWallMs());
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
            leaseEnd(nowWallMs, this.context.leaseDurationMs),
            this.context.ownerLabel,
          ],
        );
      } else {
        const epoch = acquisitionEpoch(this.context, row, nowWallMs);
        token = epoch.token;
        const renewedWallMs = epoch.isSameLiveLease
          ? Math.max(nowWallMs, row.renewedWallMs)
          : Math.max(nowWallMs, row.expiresWallMs);
        const acquiredWallMs = epoch.isSameLiveLease ? row.acquiredWallMs : renewedWallMs;
        const expiresWallMs = Math.max(
          row.expiresWallMs,
          leaseEnd(renewedWallMs, this.context.leaseDurationMs),
        );
        const changed = this.context.database.run(
          `UPDATE ownership SET owner_id = ?, owner_label = ?, fencing_token = ?,
             acquired_wall_ms = ?,
             renewed_wall_ms = ?, expires_wall_ms = ?, released_wall_ms = NULL
           WHERE singleton = 1 AND fencing_token = ? AND owner_id = ?`,
          [
            this.context.ownerGenerationId,
            this.context.ownerLabel,
            token,
            acquiredWallMs,
            renewedWallMs,
            expiresWallMs,
            row.fencingToken,
            row.ownerGenerationId,
          ],
        );
        if (changed.changes !== 1) throw new OwnershipUnavailableError("Ownership changed.");
      }
      return token as FencingToken;
    });
    const token = acquire.immediate();
    this.context.localToken = token;
    this.context.localExpiresMonotonicMs = schedule.expiresMonotonicMs;
    this.context.nextRenewMonotonicMs = schedule.nextRenewMonotonicMs;
    this.context.startupBlockedToken = this.staleClassificationComplete(token) ? undefined : token;
    return token;
  }

  isCurrent(token: FencingToken): boolean {
    if (this.context.localToken !== token) return false;
    const monotonic = this.context.nowMonotonicMs();
    if (monotonic >= this.context.localExpiresMonotonicMs) return false;
    const wall = wallTimestamp(this.context.nowWallMs());
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
    const schedule = localLeaseSchedule(monotonic, this.context.leaseDurationMs);
    const renewedWallMs = Math.max(wall, row.renewedWallMs);
    const expiresWallMs = Math.max(
      row.expiresWallMs,
      leaseEnd(renewedWallMs, this.context.leaseDurationMs),
    );
    const changed = this.context.database.run(
      `UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ?
       WHERE singleton = 1 AND owner_id = ? AND fencing_token = ?
         AND released_wall_ms IS NULL AND expires_wall_ms > ?`,
      [renewedWallMs, expiresWallMs, this.context.ownerGenerationId, token, wall],
    );
    if (changed.changes !== 1) return false;
    this.context.localExpiresMonotonicMs = schedule.expiresMonotonicMs;
    this.context.nextRenewMonotonicMs = schedule.nextRenewMonotonicMs;
    return true;
  }

  takeoverDelayMs(): number {
    const row = currentRow(this.context);
    if (!row || row.releasedWallMs !== null) return 0;
    const eligibleWallMs = row.expiresWallMs + this.context.takeoverGraceMs;
    if (!Number.isSafeInteger(eligibleWallMs)) {
      throw new StoreIntegrityError("Stored ownership takeover timing is invalid.");
    }
    return Math.max(0, eligibleWallMs - wallTimestamp(this.context.nowWallMs()));
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
    const wall = wallTimestamp(this.context.nowWallMs());
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

  /** Observe after transactional validation; apply only after immediate() durably commits. */
  staleClassificationComplete(token: FencingToken): boolean {
    const stale = this.context.database
      .query<CountRow, [string, number]>(
        `SELECT (
           (SELECT count(*) FROM deliveries
           WHERE workspace_key = ?1 AND state = 'submitting' AND claimed_fencing_token != ?2) +
           (SELECT count(*) FROM requests
            WHERE workspace_key = ?1 AND delivery_state = 'submitting'
              AND claimed_fencing_token != ?2)
         ) AS count`,
      )
      .get(this.context.workspaceKey, token);
    if (!stale || !Number.isSafeInteger(stale.count) || stale.count < 0) {
      throw new StoreIntegrityError("The startup recovery aggregate was malformed.");
    }
    return stale.count === 0;
  }

  applyCommittedStaleClassificationProgress(token: FencingToken, complete: boolean): void {
    if (complete && this.context.startupBlockedToken === token) {
      this.context.startupBlockedToken = undefined;
    }
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
    const observedWallMs = wallTimestamp(this.context.nowWallMs());
    const release = this.context.database.transaction(() => {
      const row = currentRow(this.context);
      if (
        !row ||
        row.ownerGenerationId !== this.context.ownerGenerationId ||
        row.fencingToken !== token ||
        row.releasedWallMs !== null
      ) {
        throw new OwnershipLostFault("SQLite ownership was lost.");
      }
      const releasedWallMs = Math.max(observedWallMs, row.renewedWallMs);
      if (releasedWallMs > row.expiresWallMs) {
        throw new OwnershipLostFault("SQLite ownership was lost.");
      }
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
