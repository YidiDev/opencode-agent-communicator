import type {
  CompleteRequestDeliveryInput,
  RequestStoreResult,
} from "../../application/request-ports";
import { OwnershipLostFault } from "../../domain/ownership";
import type { RequestMetadata } from "../../domain/request-types";
import type { OwnershipRepository } from "./ownership-repository";
import {
  eraseRequestPrivateContent,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
  selectRequest,
} from "./request-repository-shared";
import { type StoreContext, StoreIntegrityError } from "./store-types";

function validCompletionEvidence(
  before: RequestMetadata,
  input: CompleteRequestDeliveryInput,
  storeNowMs: number,
): boolean {
  if (input.outcome !== "admitted" && input.outcome !== "promoted") return true;
  if (
    !Number.isSafeInteger(input.admittedSeq) ||
    input.admittedSeq < 0 ||
    !Number.isSafeInteger(input.evidenceObservedAtMs) ||
    before.submittedAtMs === undefined ||
    input.evidenceObservedAtMs < before.submittedAtMs ||
    input.evidenceObservedAtMs > storeNowMs
  )
    return false;
  if (
    input.outcome === "promoted" &&
    (!Number.isSafeInteger(input.promotedSeq) || input.promotedSeq <= input.admittedSeq)
  )
    return false;
  return !(
    before.deliveryState === "admitted" &&
    (before.admissionEvidence.admittedSeq !== input.admittedSeq ||
      input.evidenceObservedAtMs < before.admittedAtMs)
  );
}

export class RequestDeliveryRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  completeDelivery(input: CompleteRequestDeliveryInput): RequestStoreResult {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    const atLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertCurrent(input.fencingToken);
        const storeNowMs = requestStoreNowMs(this.context);
        const before = selectRequest(this.context, input.workspaceKey, input.requestId);
        if (!before || !this.legal(before, input, storeNowMs)) {
          return { ok: false as const, code: "state_conflict" as const };
        }
        if (this.context.startupBlockedToken === input.fencingToken) this.assertStaleUnknown(input);
        if (before.resolutionState !== "pending") this.assertPrivateErased(before.id);
        this.writeCompletion(input, before, storeNowMs);
        this.ownership.markStaleClassificationProgress(input.fencingToken);
        const request = selectRequest(this.context, input.workspaceKey, input.requestId);
        if (!request) throw new StoreIntegrityError("The request completion result was absent.");
        return { ok: true as const, request };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  private assertStaleUnknown(input: CompleteRequestDeliveryInput): void {
    if (input.outcome !== "delivery_unknown") {
      throw new OwnershipLostFault("Startup recovery permits only stale request classification.");
    }
    const row = this.context.database
      .query<{ readonly token: number | null }, [string, string]>(
        "SELECT claimed_fencing_token AS token FROM requests WHERE workspace_key = ? AND id = ?",
      )
      .get(input.workspaceKey, input.requestId);
    if (!row || row.token === null || row.token === input.fencingToken) {
      throw new OwnershipLostFault("Only a stale-token request may cross the startup barrier.");
    }
  }

  private legal(
    before: RequestMetadata,
    input: CompleteRequestDeliveryInput,
    storeNowMs: number,
  ): boolean {
    if (storeNowMs < before.createdAtMs) return false;
    if (before.resolvedAtMs !== undefined && storeNowMs < before.resolvedAtMs) return false;
    if ("nativeMessageId" in input && input.nativeMessageId !== before.nativeMessageId)
      return false;
    if (!validCompletionEvidence(before, input, storeNowMs)) return false;
    if (
      before.deliveryState === "submitting" &&
      (input.outcome === "delivery_unknown" || input.outcome === "delivery_failed") &&
      storeNowMs < before.submittedAtMs
    )
      return false;
    if (
      before.deliveryState === "delivery_unknown" &&
      input.outcome === "delivery_failed" &&
      storeNowMs < before.deliveryUnknownAtMs
    )
      return false;
    if (before.deliveryState === "admitted" && storeNowMs < before.admittedAtMs) return false;
    if (before.deliveryState === "submitting") return true;
    if (before.deliveryState === "delivery_unknown") return input.outcome !== "delivery_unknown";
    return before.deliveryState === "admitted" && input.outcome === "promoted";
  }

  private writeCompletion(
    input: CompleteRequestDeliveryInput,
    before: RequestMetadata,
    storeNowMs: number,
  ): void {
    if (input.outcome === "delivery_unknown") {
      this.updateUnknown(input, before.deliveryState, storeNowMs);
    } else if (input.outcome === "delivery_failed") this.updateFailed(input, before, storeNowMs);
    else this.updateEvidence(input, before, storeNowMs);
  }

  private updateUnknown(
    input: CompleteRequestDeliveryInput,
    from: RequestMetadata["deliveryState"],
    storeNowMs: number,
  ): void {
    const changed = this.context.database.run(
      `UPDATE requests SET delivery_state = 'delivery_unknown', delivery_unknown_at_ms = ?,
         updated_at_ms = MAX(updated_at_ms, ?)
       WHERE workspace_key = ? AND id = ? AND delivery_state = ?`,
      [storeNowMs, storeNowMs, input.workspaceKey, input.requestId, from],
    );
    if (changed.changes !== 1) throw new StoreIntegrityError("The request unknown CAS failed.");
  }

  private updateFailed(
    input: CompleteRequestDeliveryInput,
    before: RequestMetadata,
    storeNowMs: number,
  ): void {
    const pending = before.resolutionState === "pending";
    const nextResolution = pending
      ? storeNowMs >= before.deadlineAtMs
        ? "deadline_expired"
        : "delivery_failed"
      : before.resolutionState;
    const changed = this.context.database.run(
      `UPDATE requests SET delivery_state = 'delivery_failed', resolution_state = ?,
         resolved_at_ms = CASE WHEN resolution_state = 'pending' THEN ? ELSE resolved_at_ms END,
         delivery_failed_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?),
         payload_sha256 = CASE WHEN resolution_state = 'pending' THEN NULL ELSE payload_sha256 END,
         retained_content_byte_length = CASE WHEN resolution_state = 'pending' THEN NULL ELSE retained_content_byte_length END,
         delivery_unknown_at_ms = CASE WHEN delivery_state = 'delivery_unknown' THEN delivery_unknown_at_ms ELSE NULL END,
         admitted_at_ms = NULL, promoted_at_ms = NULL, admitted_seq = NULL, promoted_seq = NULL,
         evidence_observed_at_ms = NULL
       WHERE workspace_key = ? AND id = ? AND delivery_state = ?`,
      [
        nextResolution,
        storeNowMs,
        storeNowMs,
        storeNowMs,
        input.workspaceKey,
        input.requestId,
        before.deliveryState,
      ],
    );
    if (changed.changes !== 1) throw new StoreIntegrityError("The request failure CAS failed.");
    if (pending) eraseRequestPrivateContent(this.context, before.id);
  }

  private updateEvidence(
    input: Extract<CompleteRequestDeliveryInput, { readonly outcome: "admitted" | "promoted" }>,
    before: RequestMetadata,
    storeNowMs: number,
  ): void {
    const promoted = input.outcome === "promoted";
    const changed = this.context.database.run(
      `UPDATE requests SET delivery_state = ?, updated_at_ms = MAX(updated_at_ms, ?, ?),
         admitted_at_ms = CASE WHEN delivery_state = 'admitted' THEN admitted_at_ms ELSE ? END,
         promoted_at_ms = ?, admitted_seq = CASE WHEN delivery_state = 'admitted' THEN admitted_seq ELSE ? END,
         promoted_seq = ?, evidence_observed_at_ms = ?, delivery_unknown_at_ms = NULL,
         delivery_failed_at_ms = NULL
       WHERE workspace_key = ? AND id = ? AND delivery_state = ?`,
      [
        input.outcome,
        storeNowMs,
        input.evidenceObservedAtMs,
        input.evidenceObservedAtMs,
        promoted ? input.evidenceObservedAtMs : null,
        input.admittedSeq,
        promoted ? input.promotedSeq : null,
        input.evidenceObservedAtMs,
        input.workspaceKey,
        input.requestId,
        before.deliveryState,
      ],
    );
    if (changed.changes !== 1) throw new StoreIntegrityError("The request evidence CAS failed.");
  }

  private assertPrivateErased(requestId: string): void {
    const row = this.context.database
      .query<{ readonly count: number }, [string]>(
        `SELECT (SELECT count(*) FROM request_payloads WHERE request_id = ?1) +
                (SELECT count(*) FROM request_wait_edges WHERE request_id = ?1) AS count`,
      )
      .get(requestId);
    if (row?.count !== 0) throw new StoreIntegrityError("Terminal request content was retained.");
  }
}
