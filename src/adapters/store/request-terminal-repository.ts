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
  validateWaitRequestResult,
} from "../../domain/request-content";
import type {
  AnsweredAskRequestMetadata,
  AskRequestResult,
  PendingRequestMetadata,
  ReachedWaitRequestMetadata,
  RequestMetadata,
  WaitRequestResult,
} from "../../domain/request-types";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import { validatePendingPrivateContent } from "./request-persistence-validation";
import {
  assertPendingWaitEdge,
  eraseRequestPrivateContent,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
  selectRequest,
} from "./request-repository-shared";
import { canonicalRequestResult, coherentCanonicalRequestResult } from "./request-result-canonical";
import { availableResultQuotaAllows } from "./request-result-quotas";
import { validateStoredResultState } from "./request-result-validation";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { RequestSourceTerminalRepository } from "./request-source-terminal-repository";
import { type StoreContext, StoreIntegrityError } from "./store-types";

interface ParticipantRequestRow extends RequestRow {
  readonly payloadJson: unknown;
  readonly envelopeJson: unknown;
  readonly retainedContentBytes: unknown;
}

type AskWriteResult = RequestTerminalWriteResult<AnsweredAskRequestMetadata, AskRequestResult>;
type WaitWriteResult = RequestTerminalWriteResult<ReachedWaitRequestMetadata, WaitRequestResult>;
type WriteResult = AskWriteResult | WaitWriteResult;

export class RequestTerminalRepository {
  private readonly source: RequestSourceTerminalRepository;

  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {
    this.source = new RequestSourceTerminalRepository(context, ownership);
  }

  answerAsk(
    input: RequestParticipantMutationInput & { readonly answers: AskRequestResult["answers"] },
  ): AskWriteResult {
    if (!this.validParticipantInput(input)) return this.notFound();
    let candidate: ReturnType<typeof canonicalRequestResult>;
    try {
      candidate = canonicalRequestResult({ kind: "ask", answers: input.answers });
    } catch {
      candidate = undefined;
    }
    return this.writeTarget(input, "ask", candidate);
  }

  signalWait(
    input: RequestParticipantMutationInput & { readonly evidence?: string },
  ): WaitWriteResult {
    if (!this.validParticipantInput(input)) return this.notFound();
    let candidate: ReturnType<typeof canonicalRequestResult>;
    try {
      const proposed:
        | { readonly kind: "wait"; readonly evidence: string | undefined }
        | { readonly kind: "wait" } = Object.hasOwn(input, "evidence")
        ? { kind: "wait", evidence: input.evidence }
        : { kind: "wait" };
      candidate = canonicalRequestResult(proposed);
    } catch {
      candidate = undefined;
    }
    return this.writeTarget(input, "wait", candidate);
  }

  private writeTarget(
    input: RequestParticipantMutationInput,
    kind: "ask",
    candidate: ReturnType<typeof canonicalRequestResult>,
  ): AskWriteResult;
  private writeTarget(
    input: RequestParticipantMutationInput,
    kind: "wait",
    candidate: ReturnType<typeof canonicalRequestResult>,
  ): WaitWriteResult;
  private writeTarget(
    input: RequestParticipantMutationInput,
    kind: "ask" | "wait",
    candidate: ReturnType<typeof canonicalRequestResult>,
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
    candidate: ReturnType<typeof canonicalRequestResult>,
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
      !coherentCanonicalRequestResult(candidate) ||
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
    candidate: NonNullable<ReturnType<typeof canonicalRequestResult>>,
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
    return this.source.cancelPending(input);
  }

  acknowledgeResult(input: RequestParticipantMutationInput): AcknowledgeRequestResult {
    return this.source.acknowledgeResult(input);
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
