import type {
  AcknowledgeRequestResult,
  CancelPendingResult,
  RequestParticipantMutationInput,
} from "../../application/request-ports";
import { validateRequestId } from "../../domain/generated-ids";
import type { PendingRequestMetadata, RequestMetadata } from "../../domain/request-types";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import { validatePendingPrivateContent } from "./request-persistence-validation";
import {
  assertPendingWaitEdge,
  eraseRequestPrivateContent,
  eraseStoredResult,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
  selectRequest,
} from "./request-repository-shared";
import { validateStoredResultState } from "./request-result-validation";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

interface ParticipantRequestRow extends RequestRow {
  readonly payloadJson: unknown;
  readonly envelopeJson: unknown;
  readonly retainedContentBytes: unknown;
}

type TerminalRequestMetadata = Exclude<RequestMetadata, PendingRequestMetadata>;

function cancelTerminalResult(request: TerminalRequestMetadata): CancelPendingResult {
  if (request.resolutionState === "cancelled") {
    return { ok: true, outcome: "idempotent", resolutionState: "cancelled", request };
  }
  return {
    ok: true,
    outcome: "terminal_state",
    resolutionState: request.resolutionState,
    request,
  } as CancelPendingResult;
}

export class RequestSourceTerminalRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  cancelPending(input: RequestParticipantMutationInput): CancelPendingResult {
    if (!this.validParticipantInput(input)) return this.notFound();
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction((): CancelPendingResult => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          const row = this.selectForSource(input);
          if (!row) return this.notFound();
          const before = hydrateRequest(row);
          if (before.resolutionState !== "pending") {
            validateStoredResultState(this.context, before);
            return cancelTerminalResult(before);
          }
          const nowMs = requestStoreNowMs(this.context);
          if (nowMs < before.updatedAtMs) return { ok: false, code: "state_conflict" };
          if (nowMs >= before.deadlineAtMs) {
            const request = this.expirePending(before, nowMs);
            if (request.resolutionState !== "deadline_expired")
              throw new StoreIntegrityError("The deadline winner was malformed.");
            return {
              ok: true,
              outcome: "terminal_state",
              resolutionState: request.resolutionState,
              request,
            };
          }
          this.assertPendingPrivateState(before, row);
          eraseRequestPrivateContent(this.context, before.id);
          const changed = this.context.database.run(
            `UPDATE requests SET resolution_state = 'cancelled', resolved_at_ms = ?, updated_at_ms = ?,
           payload_sha256 = NULL, retained_content_byte_length = NULL
           WHERE workspace_key = ? AND id = ? AND resolution_state = 'pending' AND deadline_at_ms > ?`,
            [nowMs, nowMs, input.workspaceKey, input.requestId, nowMs],
          );
          if (changed.changes !== 1)
            throw new StoreIntegrityError("The request cancellation CAS failed.");
          const request = selectRequest(this.context, input.workspaceKey, input.requestId);
          if (request?.resolutionState !== "cancelled")
            throw new StoreIntegrityError("The cancellation result was malformed.");
          return { ok: true, outcome: "applied", resolutionState: "cancelled", request };
        })
        .immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  acknowledgeResult(input: RequestParticipantMutationInput): AcknowledgeRequestResult {
    if (!this.validParticipantInput(input)) return this.notFound();
    const atLimit = requestPageLimitReached(this.context);
    try {
      return (
        this.context.database
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction keeps result erasure and authoritative checks atomic.
          .transaction((): AcknowledgeRequestResult => {
            this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
            const row = this.selectForSource(input);
            if (!row) return this.notFound();
            const before = hydrateRequest(row);
            if (before.resultState === "acknowledged") {
              validateStoredResultState(this.context, before);
              return { ok: true, outcome: "idempotent", request: before };
            }
            if (before.resultState !== "available" && before.resultState !== "expired") {
              if (before.resolutionState === "pending") this.assertPendingPrivateState(before, row);
              validateStoredResultState(this.context, before);
              return { ok: false, code: "state_conflict" };
            }
            const nowMs = requestStoreNowMs(this.context);
            if (nowMs < before.updatedAtMs) return { ok: false, code: "state_conflict" };
            eraseStoredResult(this.context, before.id);
            const expiredAtMs =
              before.resultState === "available" && nowMs >= before.resultExpiresAtMs
                ? nowMs
                : before.resultExpiredAtMs;
            const changed = this.context.database.run(
              `UPDATE requests SET result_state = 'acknowledged', acknowledged_at_ms = ?,
           updated_at_ms = ?, result_expired_at_ms = ?, result_byte_length = NULL, result_sha256 = NULL
           WHERE workspace_key = ? AND id = ? AND result_state = ?`,
              [
                nowMs,
                nowMs,
                expiredAtMs ?? null,
                input.workspaceKey,
                input.requestId,
                before.resultState,
              ],
            );
            if (changed.changes !== 1)
              throw new StoreIntegrityError("The result acknowledgement CAS failed.");
            const request = selectRequest(this.context, input.workspaceKey, input.requestId);
            if (!request) throw new StoreIntegrityError("The acknowledged request was absent.");
            validateStoredResultState(this.context, request);
            if (
              (request.resolutionState !== "answered" && request.resolutionState !== "reached") ||
              request.resultState !== "acknowledged"
            ) {
              throw new StoreIntegrityError("The acknowledged request state was malformed.");
            }
            return { ok: true, outcome: "applied", request };
          })
          .immediate()
      );
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  private validParticipantInput(input: RequestParticipantMutationInput): boolean {
    return (
      input.workspaceKey === this.context.workspaceKey &&
      validateWorkspaceKey(input.workspaceKey).ok &&
      validateRequestId(input.requestId).ok &&
      validateSessionId(input.callerSessionId).ok
    );
  }

  private selectForSource(
    input: RequestParticipantMutationInput,
  ): ParticipantRequestRow | undefined {
    return (
      this.context.database
        .query<ParticipantRequestRow, [string, string, string]>(
          `SELECT ${requestMetadataColumns}, payload.payload_json AS payloadJson,
       payload.envelope_json AS envelopeJson, requests.retained_content_byte_length AS retainedContentBytes
       FROM requests LEFT JOIN request_payloads AS payload ON payload.request_id = requests.id
       WHERE requests.workspace_key = ? AND requests.id = ? AND requests.source_session_id = ?`,
        )
        .get(input.workspaceKey, input.requestId, input.callerSessionId) ?? undefined
    );
  }

  private assertPendingPrivateState(
    request: PendingRequestMetadata,
    row: ParticipantRequestRow,
  ): void {
    const content = validatePendingPrivateContent(
      request,
      row.payloadJson,
      row.envelopeJson,
      row.retainedContentBytes,
    );
    if (!content) throw new StoreIntegrityError("Stored pending request content was invalid.");
    assertPendingWaitEdge(this.context, request);
  }

  private expirePending(before: PendingRequestMetadata, nowMs: number): RequestMetadata {
    eraseRequestPrivateContent(this.context, before.id);
    const changed = this.context.database.run(
      `UPDATE requests SET resolution_state = 'deadline_expired', resolved_at_ms = ?,
       updated_at_ms = ?, payload_sha256 = NULL, retained_content_byte_length = NULL
       WHERE workspace_key = ? AND id = ? AND resolution_state = 'pending' AND deadline_at_ms <= ?`,
      [nowMs, nowMs, before.workspaceKey, before.id, nowMs],
    );
    if (changed.changes !== 1) throw new StoreIntegrityError("The request deadline CAS failed.");
    const request = selectRequest(this.context, before.workspaceKey, before.id);
    if (!request) throw new StoreIntegrityError("The deadline-expired request was absent.");
    return request;
  }

  private notFound(): { readonly ok: false; readonly code: "not_found_or_unauthorized" } {
    return { ok: false, code: "not_found_or_unauthorized" };
  }
}
