import { createHash } from "node:crypto";

import type {
  AcknowledgeRequestResult,
  CancelPendingResult,
  RequestParticipantMutationInput,
  RequestTerminalWriteResult,
} from "../../application/request-ports";
import { validateRequestId } from "../../domain/generated-ids";
import { requestLimits } from "../../domain/request-constants";
import {
  validateAskResponseAgainstPendingPayload,
  validateRetainedRequestResult,
  validateWaitRequestResult,
} from "../../domain/request-content";
import { serializeRetainedRequestResult } from "../../domain/request-serialization";
import type {
  AnsweredAskRequestMetadata,
  AskRequestResult,
  PendingRequestMetadata,
  ReachedWaitRequestMetadata,
  RequestMetadata,
  RetainedRequestResult,
  WaitRequestResult,
} from "../../domain/request-types";
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
import { availableResultQuotaAllows } from "./request-result-quotas";
import { validateStoredResultState } from "./request-result-validation";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

interface ParticipantRequestRow extends RequestRow {
  readonly payloadJson: unknown;
  readonly envelopeJson: unknown;
  readonly retainedContentBytes: unknown;
}

type AskWriteResult = RequestTerminalWriteResult<AnsweredAskRequestMetadata, AskRequestResult>;
type WaitWriteResult = RequestTerminalWriteResult<ReachedWaitRequestMetadata, WaitRequestResult>;
type WriteResult = AskWriteResult | WaitWriteResult;
type TerminalRequestMetadata = Exclude<RequestMetadata, PendingRequestMetadata>;

function cancelTerminalResult(request: TerminalRequestMetadata): CancelPendingResult {
  switch (request.resolutionState) {
    case "cancelled":
      return { ok: true, outcome: "idempotent", resolutionState: "cancelled", request };
    case "answered":
      return { ok: true, outcome: "terminal_state", resolutionState: "answered", request };
    case "reached":
      return { ok: true, outcome: "terminal_state", resolutionState: "reached", request };
    case "deadline_expired":
      return { ok: true, outcome: "terminal_state", resolutionState: "deadline_expired", request };
    case "delivery_failed":
      return { ok: true, outcome: "terminal_state", resolutionState: "delivery_failed", request };
    case "target_stopped":
      return { ok: true, outcome: "terminal_state", resolutionState: "target_stopped", request };
    case "source_stopped":
      return { ok: true, outcome: "terminal_state", resolutionState: "source_stopped", request };
    case "target_deleted":
      return { ok: true, outcome: "terminal_state", resolutionState: "target_deleted", request };
    case "source_deleted":
      return { ok: true, outcome: "terminal_state", resolutionState: "source_deleted", request };
  }
}

function canonicalInput(result: unknown):
  | {
      readonly value: RetainedRequestResult;
      readonly json: string;
      readonly bytes: number;
      readonly digest: string;
    }
  | undefined {
  const validated = validateRetainedRequestResult(result);
  if (!validated.ok) return undefined;
  const json = serializeRetainedRequestResult(validated.value);
  const encoded = new TextEncoder().encode(json);
  return {
    value: validated.value,
    json,
    bytes: encoded.length,
    digest: createHash("sha256").update(encoded).digest("hex"),
  };
}

function coherentCanonicalCandidate(
  candidate: NonNullable<ReturnType<typeof canonicalInput>>,
): boolean {
  const json = serializeRetainedRequestResult(candidate.value);
  const bytes = new TextEncoder().encode(json);
  return (
    json === candidate.json &&
    bytes.length === candidate.bytes &&
    createHash("sha256").update(bytes).digest("hex") === candidate.digest
  );
}

export class RequestTerminalRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  answerAsk(
    input: RequestParticipantMutationInput & { readonly answers: AskRequestResult["answers"] },
  ): AskWriteResult {
    if (!this.validParticipantInput(input)) return this.notFound();
    let candidate: ReturnType<typeof canonicalInput>;
    try {
      candidate = canonicalInput({ kind: "ask", answers: input.answers });
    } catch {
      candidate = undefined;
    }
    return this.writeTarget(input, "ask", candidate);
  }

  signalWait(
    input: RequestParticipantMutationInput & { readonly evidence?: string },
  ): WaitWriteResult {
    if (!this.validParticipantInput(input)) return this.notFound();
    let candidate: ReturnType<typeof canonicalInput>;
    try {
      const proposed:
        | { readonly kind: "wait"; readonly evidence: string | undefined }
        | { readonly kind: "wait" } = Object.hasOwn(input, "evidence")
        ? { kind: "wait", evidence: input.evidence }
        : { kind: "wait" };
      candidate = canonicalInput(proposed);
    } catch {
      candidate = undefined;
    }
    return this.writeTarget(input, "wait", candidate);
  }

  private writeTarget(
    input: RequestParticipantMutationInput,
    kind: "ask",
    candidate: ReturnType<typeof canonicalInput>,
  ): AskWriteResult;
  private writeTarget(
    input: RequestParticipantMutationInput,
    kind: "wait",
    candidate: ReturnType<typeof canonicalInput>,
  ): WaitWriteResult;
  private writeTarget(
    input: RequestParticipantMutationInput,
    kind: "ask" | "wait",
    candidate: ReturnType<typeof canonicalInput>,
  ): WriteResult {
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction(() => this.writeTargetOwned(input, kind, candidate))
        .immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  private writeTargetOwned(
    input: RequestParticipantMutationInput,
    kind: "ask" | "wait",
    candidate: ReturnType<typeof canonicalInput>,
  ): WriteResult {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    const row = this.selectForRole(input, "target");
    if (!row) return this.notFound();
    const before = hydrateRequest(row);
    if (before.resolutionState !== "pending") {
      validateStoredResultState(this.context, before);
      return { ok: false, code: "state_conflict", request: before };
    }
    const nowMs = requestStoreNowMs(this.context);
    if (nowMs < before.updatedAtMs) return { ok: false, code: "state_conflict", request: before };
    if (nowMs >= before.deadlineAtMs) {
      return { ok: false, code: "state_conflict", request: this.expirePending(before, nowMs) };
    }
    const privateContent = validatePendingPrivateContent(
      before,
      row.payloadJson,
      row.envelopeJson,
      row.retainedContentBytes,
    );
    if (!privateContent)
      throw new StoreIntegrityError("Stored pending request content was invalid.");
    assertPendingWaitEdge(this.context, before);
    if (!candidate || before.kind !== kind || privateContent.payload.kind !== kind) {
      return { ok: false, code: "state_conflict", request: before };
    }
    const validResponse =
      kind === "ask"
        ? validateAskResponseAgainstPendingPayload(candidate.value, privateContent.payload)
        : validateWaitRequestResult(candidate.value);
    if (
      !validResponse.ok ||
      !coherentCanonicalCandidate(candidate) ||
      !Number.isSafeInteger(nowMs + requestLimits.resultRetentionMs)
    ) {
      return { ok: false, code: "state_conflict", request: before };
    }
    if (!availableResultQuotaAllows(this.context, before, candidate.bytes)) {
      return { ok: false, code: "quota_exceeded" };
    }
    return this.persistResult(input, before, kind, candidate, nowMs);
  }

  private persistResult(
    input: RequestParticipantMutationInput,
    before: PendingRequestMetadata,
    kind: "ask" | "wait",
    candidate: NonNullable<ReturnType<typeof canonicalInput>>,
    nowMs: number,
  ): WriteResult {
    eraseRequestPrivateContent(this.context, before.id);
    const changed = this.context.database.run(
      `UPDATE requests SET resolution_state = ?, resolved_at_ms = ?, updated_at_ms = ?,
         payload_sha256 = NULL, retained_content_byte_length = NULL,
         result_state = 'available', result_byte_length = ?, result_sha256 = ?,
         result_available_at_ms = ?, result_expires_at_ms = ?
       WHERE workspace_key = ? AND id = ? AND resolution_state = 'pending' AND deadline_at_ms > ?`,
      [
        kind === "ask" ? "answered" : "reached",
        nowMs,
        nowMs,
        candidate.bytes,
        candidate.digest,
        nowMs,
        nowMs + requestLimits.resultRetentionMs,
        input.workspaceKey,
        input.requestId,
        nowMs,
      ],
    );
    if (changed.changes !== 1) throw new StoreIntegrityError("The request result CAS failed.");
    this.context.database.run(
      "INSERT INTO request_results(request_id, result_json) VALUES (?, ?)",
      [before.id, candidate.json],
    );
    const request = selectRequest(this.context, input.workspaceKey, input.requestId);
    if (!request) throw new StoreIntegrityError("The persisted request result was absent.");
    const retained = validateStoredResultState(this.context, request);
    if (!retained) throw new StoreIntegrityError("The persisted request result was erased.");
    if (
      kind === "ask" &&
      request.resolutionState === "answered" &&
      retained.result.kind === "ask"
    ) {
      return { ok: true, outcome: "applied", request, result: retained.result };
    }
    if (
      kind === "wait" &&
      request.resolutionState === "reached" &&
      retained.result.kind === "wait"
    ) {
      return { ok: true, outcome: "applied", request, result: retained.result };
    }
    throw new StoreIntegrityError("The persisted request result type was incoherent.");
  }

  cancelPending(input: RequestParticipantMutationInput): CancelPendingResult {
    if (!this.validParticipantInput(input)) return this.notFound();
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction((): CancelPendingResult => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          const row = this.selectForRole(input, "source");
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
            if (request.resolutionState !== "deadline_expired") {
              throw new StoreIntegrityError("The deadline winner was malformed.");
            }
            return {
              ok: true,
              outcome: "terminal_state",
              resolutionState: request.resolutionState,
              request,
            };
          }
          const content = validatePendingPrivateContent(
            before,
            row.payloadJson,
            row.envelopeJson,
            row.retainedContentBytes,
          );
          if (!content)
            throw new StoreIntegrityError("Stored pending request content was invalid.");
          assertPendingWaitEdge(this.context, before);
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
          if (!request) throw new StoreIntegrityError("The cancelled request was absent.");
          if (request.resolutionState !== "cancelled") {
            throw new StoreIntegrityError("The cancellation result was malformed.");
          }
          return {
            ok: true,
            outcome: "applied",
            resolutionState: "cancelled",
            request,
          };
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
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction keeps result erasure and every authoritative state check atomic.
          .transaction((): AcknowledgeRequestResult => {
            this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
            const row = this.selectForRole(input, "source");
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
              updated_at_ms = ?, result_expired_at_ms = ?,
              result_byte_length = NULL, result_sha256 = NULL
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

  private selectForRole(
    input: RequestParticipantMutationInput,
    role: "source" | "target",
  ): ParticipantRequestRow | undefined {
    const participantColumn = role === "source" ? "source_session_id" : "target_session_id";
    return (
      this.context.database
        .query<ParticipantRequestRow, [string, string, string]>(
          `SELECT ${requestMetadataColumns}, payload.payload_json AS payloadJson,
             payload.envelope_json AS envelopeJson,
             requests.retained_content_byte_length AS retainedContentBytes
           FROM requests LEFT JOIN request_payloads AS payload ON payload.request_id = requests.id
           WHERE requests.workspace_key = ? AND requests.id = ?
             AND requests.${participantColumn} = ?`,
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
