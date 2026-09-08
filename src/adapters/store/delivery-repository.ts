import { SQLiteError } from "bun:sqlite";
import type {
  CompleteSubmissionInput,
  DeliveryClaimResult,
  DeliveryStoreFailureCode,
  DeliveryStoreResult,
  DeliveryTransitionInput,
  PrepareDeliveryInput,
} from "../../application/delivery-ports";
import type { DeliveryMetadata } from "../../domain/deliveries";
import { OwnershipLostFault } from "../../domain/ownership";
import {
  assertStaleDeliveryClassification,
  isLegalDeliveryCompletion,
  validDeliveryEvidenceChronology,
  writeDeliveryCompletion,
} from "./delivery-completion";
import { checkDeliveryCreateQuotas, recordDeliveryRateEvent } from "./delivery-quotas";
import { type DeliveryRow, deliveryMetadataColumns, hydrateDelivery } from "./delivery-rows";
import type { OwnershipRepository } from "./ownership-repository";
import { storeNowMs } from "./store-clock";
import { type StoreContext, StoreIntegrityError } from "./store-types";

interface EnvelopeRow extends DeliveryRow {
  readonly preparedEnvelope: unknown;
}

const sqlitePrimaryIoError = 10;
const sqlitePrimaryFull = 13;
const sqlitePrimaryReadonly = 8;

function sqlitePrimaryCode(error: Pick<SQLiteError, "errno">): number {
  return error.errno & 0xff;
}

export function classifySqliteStorageError(
  error: Pick<SQLiteError, "code" | "errno">,
  deterministicallyAtPageLimit: () => boolean,
): DeliveryStoreFailureCode {
  const primary = sqlitePrimaryCode(error);
  if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return "state_conflict";
  }
  if (primary === sqlitePrimaryFull) {
    return deterministicallyAtPageLimit() ? "quota_exceeded" : "storage_unavailable";
  }
  if (primary === sqlitePrimaryIoError || primary === sqlitePrimaryReadonly) {
    return "storage_unavailable";
  }
  return "storage_unavailable";
}

/** Classifies only structured SQLite diagnostics; localized error text is never trusted. */
export function classifyDeliveryStorageError(
  cause: unknown,
  deterministicallyAtPageLimit: () => boolean,
): DeliveryStoreFailureCode {
  if (cause instanceof OwnershipLostFault) return "ownership_lost";
  if (cause instanceof StoreIntegrityError) return "state_conflict";
  if (!(cause instanceof SQLiteError)) return "storage_unavailable";
  return classifySqliteStorageError(cause, deterministicallyAtPageLimit);
}

function failure(
  cause: unknown,
  pageLimitReachedBeforeMutation: boolean,
): { readonly ok: false; readonly code: DeliveryStoreFailureCode } {
  if (cause instanceof OwnershipLostFault) return { ok: false, code: "ownership_lost" };
  return {
    ok: false,
    code: classifyDeliveryStorageError(cause, () => pageLimitReachedBeforeMutation),
  };
}

function deterministicallyAtPageLimit(context: StoreContext): boolean {
  try {
    const pageCount = context.database
      .query<{ readonly value: number }, []>("SELECT page_count AS value FROM pragma_page_count")
      .get()?.value;
    const freePages = context.database
      .query<{ readonly value: number }, []>(
        "SELECT freelist_count AS value FROM pragma_freelist_count",
      )
      .get()?.value;
    return pageCount === context.maximumPageCount && freePages === 0;
  } catch {
    return false;
  }
}

function selectDelivery(
  context: StoreContext,
  workspaceKey: string,
  deliveryId: string,
): DeliveryMetadata | undefined {
  const row = context.database
    .query<DeliveryRow, [string, string]>(
      `SELECT ${deliveryMetadataColumns} FROM deliveries WHERE workspace_key = ? AND id = ?`,
    )
    .get(workspaceKey, deliveryId);
  return row ? hydrateDelivery(row) : undefined;
}

export class DeliveryRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  createPrepared(input: PrepareDeliveryInput): DeliveryStoreResult {
    if (input.workspaceKey !== this.context.workspaceKey) {
      return { ok: false, code: "state_conflict" };
    }
    const pageLimitReached = deterministicallyAtPageLimit(this.context);
    try {
      const envelopeBytes = new TextEncoder().encode(input.envelope).length;
      if (envelopeBytes > 64 * 1024) {
        return { ok: false, code: "quota_exceeded" };
      }
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const quotaFailure = checkDeliveryCreateQuotas(this.context, input, envelopeBytes);
        if (quotaFailure) return { ok: false as const, code: quotaFailure };
        this.context.database.run(
          "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES (?, ?)",
          [input.workspaceKey, input.nowMs],
        );
        this.context.database.run(
          `INSERT INTO deliveries(id, workspace_key, source_session_id, target_session_id,
             native_message_id, state, prepared_envelope, content_byte_length, content_sha256,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)`,
          [
            input.id,
            input.workspaceKey,
            input.sourceSessionId,
            input.targetSessionId,
            input.nativeMessageId,
            input.envelope,
            input.contentByteLength,
            input.contentSha256,
            input.nowMs,
            input.nowMs,
          ],
        );
        recordDeliveryRateEvent(this.context, input);
        const delivery = selectDelivery(this.context, input.workspaceKey, input.id);
        if (!delivery) throw new StoreIntegrityError("A prepared delivery was not persisted.");
        return { ok: true as const, delivery };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return failure(cause, pageLimitReached);
    }
  }

  cancelPrepared(input: DeliveryTransitionInput): DeliveryStoreResult {
    return this.preparedMutation(input, "cancelled");
  }

  private preparedMutation(
    input: DeliveryTransitionInput,
    target: "cancelled",
  ): DeliveryStoreResult {
    if (input.workspaceKey !== this.context.workspaceKey) {
      return { ok: false, code: "state_conflict" };
    }
    const pageLimitReached = deterministicallyAtPageLimit(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const changed = this.context.database.run(
          `UPDATE deliveries SET state = ?, prepared_envelope = NULL, updated_at_ms = ?,
             cancelled_at_ms = ?
           WHERE workspace_key = ? AND id = ? AND state = 'prepared'`,
          [target, input.nowMs, input.nowMs, input.workspaceKey, input.deliveryId],
        );
        if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
        const delivery = selectDelivery(this.context, input.workspaceKey, input.deliveryId);
        if (!delivery) throw new StoreIntegrityError("The delivery transition target was absent.");
        return { ok: true as const, delivery };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return failure(cause, pageLimitReached);
    }
  }

  claimPrepared(input: DeliveryTransitionInput): DeliveryClaimResult {
    if (input.workspaceKey !== this.context.workspaceKey) {
      return { ok: false, code: "state_conflict" };
    }
    const pageLimitReached = deterministicallyAtPageLimit(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const row = this.context.database
          .query<EnvelopeRow, [string, string]>(
            `SELECT ${deliveryMetadataColumns}, prepared_envelope AS preparedEnvelope
             FROM deliveries WHERE workspace_key = ? AND id = ?`,
          )
          .get(input.workspaceKey, input.deliveryId);
        if (!row) throw new StoreIntegrityError("The delivery claim target was absent.");
        const before = hydrateDelivery(row);
        if (before.state !== "prepared") return { ok: true as const, delivery: before };
        if (typeof row.preparedEnvelope !== "string") {
          throw new StoreIntegrityError("A prepared delivery envelope was absent.");
        }
        const changed = this.context.database.run(
          `UPDATE deliveries SET state = 'submitting', prepared_envelope = NULL,
             submitted_at_ms = ?, updated_at_ms = ?, claimed_fencing_token = ?
           WHERE workspace_key = ? AND id = ? AND state = 'prepared'`,
          [input.nowMs, input.nowMs, input.fencingToken, input.workspaceKey, input.deliveryId],
        );
        if (changed.changes !== 1) throw new StoreIntegrityError("The delivery claim CAS failed.");
        const delivery = selectDelivery(this.context, input.workspaceKey, input.deliveryId);
        if (delivery?.state !== "submitting") {
          throw new StoreIntegrityError("The delivery claim result was malformed.");
        }
        const submittingDelivery: DeliveryMetadata & { readonly state: "submitting" } = {
          ...delivery,
          state: "submitting",
        };
        return { ok: true as const, delivery: submittingDelivery, envelope: row.preparedEnvelope };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return failure(cause, pageLimitReached);
    }
  }

  completeSubmission(input: CompleteSubmissionInput): DeliveryStoreResult {
    if (input.workspaceKey !== this.context.workspaceKey) {
      return { ok: false, code: "state_conflict" };
    }
    const pageLimitReached = deterministicallyAtPageLimit(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertCurrent(input.fencingToken);
        const trustedNowMs = storeNowMs(this.context);
        const before = selectDelivery(this.context, input.workspaceKey, input.deliveryId);
        if (!before) throw new StoreIntegrityError("The delivery completion target was absent.");
        const classifyingStaleSubmission = this.context.startupBlockedToken === input.fencingToken;
        if (classifyingStaleSubmission) {
          assertStaleDeliveryClassification(this.context, input);
        }
        if (!isLegalDeliveryCompletion(before.state, input.state)) {
          return {
            result: { ok: false as const, code: "state_conflict" as const },
            staleClassificationComplete: undefined,
          };
        }
        if (!validDeliveryEvidenceChronology(before, input, trustedNowMs)) {
          return {
            result: { ok: false as const, code: "state_conflict" as const },
            staleClassificationComplete: undefined,
          };
        }
        if (
          before.state === "admitted" &&
          input.state === "promoted" &&
          (before.admissionEvidence?.kind === "public_message" ||
            before.admissionEvidence?.admittedSeq !== input.admittedSeq)
        ) {
          return {
            result: { ok: false as const, code: "state_conflict" as const },
            staleClassificationComplete: undefined,
          };
        }
        writeDeliveryCompletion(this.context, input, before.state, trustedNowMs);
        const delivery = selectDelivery(this.context, input.workspaceKey, input.deliveryId);
        if (!delivery) throw new StoreIntegrityError("The delivery completion result was absent.");
        return {
          result: { ok: true as const, delivery },
          staleClassificationComplete: classifyingStaleSubmission
            ? this.ownership.staleClassificationComplete(input.fencingToken)
            : undefined,
        };
      });
      const committed = transaction.immediate();
      if (committed.staleClassificationComplete !== undefined) {
        this.ownership.applyCommittedStaleClassificationProgress(
          input.fencingToken,
          committed.staleClassificationComplete,
        );
      }
      return committed.result;
    } catch (cause: unknown) {
      return failure(cause, pageLimitReached);
    }
  }
}
