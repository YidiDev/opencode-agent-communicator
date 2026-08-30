import type {
  CompleteRequestDeliveryInput,
  RequestStoreResult,
} from "../../application/request-ports";
import { validateRequestId } from "../../domain/generated-ids";
import { OwnershipLostFault } from "../../domain/ownership";
import type { RequestMetadata } from "../../domain/request-types";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import {
  eraseRequestPrivateContent,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
  selectRequest,
} from "./request-repository-shared";
import { validateStoredResultState } from "./request-result-validation";
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
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateWorkspaceKey(input.workspaceKey).ok ||
      !validateRequestId(input.requestId).ok
    )
      return { ok: false, code: "state_conflict" };
    const atLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertCurrent(input.fencingToken);
        const storeNowMs = requestStoreNowMs(this.context);
        const before = selectRequest(this.context, input.workspaceKey, input.requestId);
        if (!before || !this.legal(before, input, storeNowMs)) {
          return {
            result: { ok: false as const, code: "state_conflict" as const },
            staleClassificationComplete: undefined,
          };
        }
        const classifyingStaleSubmission = this.context.startupBlockedToken === input.fencingToken;
        if (classifyingStaleSubmission) this.assertStaleClassification(input);
        if (before.resolutionState !== "pending") validateStoredResultState(this.context, before);
        this.writeCompletion(input, before, storeNowMs);
        const request = selectRequest(this.context, input.workspaceKey, input.requestId);
        if (!request) throw new StoreIntegrityError("The request completion result was absent.");
        if (request.resolutionState !== "pending") {
          validateStoredResultState(this.context, request);
        }
        return {
          result: { ok: true as const, request },
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
      return requestFailure(cause, atLimit);
    }
  }

  private assertStaleClassification(input: CompleteRequestDeliveryInput): void {
    const row = this.context.database
      .query<
        {
          readonly token: number | null;
          readonly authoritative: number;
        },
        [string, string, string]
      >(
        `SELECT request.claimed_fencing_token AS token,
           CASE
             WHEN ?3 = 'delivery_unknown' THEN 1
             WHEN request.delivery_mode <> 'initial' OR operation.id IS NULL THEN 0
             WHEN ?3 = 'admitted' AND operation.admission_state = 'admitted' THEN 1
             WHEN ?3 = 'delivery_failed' AND (
               operation.creation_state = 'failed' OR operation.admission_state = 'failed' OR
               operation.terminal_reason = 'request_terminal' OR
               (operation.creation_state = 'created' AND
                 operation.admission_state = 'payload_unavailable')
             ) THEN 1
             ELSE 0
           END AS authoritative
         FROM requests AS request
         LEFT JOIN start_operations AS operation
           ON operation.workspace_key = request.workspace_key
          AND operation.id = request.linked_start_operation_id
         WHERE request.workspace_key = ?1 AND request.id = ?2`,
      )
      .get(input.workspaceKey, input.requestId, input.outcome);
    if (!row || row.token === null || row.token === input.fencingToken) {
      throw new OwnershipLostFault("Only a stale-token request may cross the startup barrier.");
    }
    if (row.authoritative !== 1) {
      throw new OwnershipLostFault(
        "Definitive stale classification requires authoritative linked-start state.",
      );
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
    if (pending) eraseRequestPrivateContent(this.context, before.id);
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
}
