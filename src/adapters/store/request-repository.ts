import type {
  ExpireDueRequestsResult,
  PrepareRequestInput,
  RequestClaimReconciliation,
  RequestClaimResult,
  RequestCreationReconciliation,
  RequestStoreResult,
  RequestTransitionInput,
} from "../../application/request-ports";
import { validateRequestId, validateStartOperationId } from "../../domain/generated-ids";
import { validateFencingToken } from "../../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../../domain/request-identity";
import type { PendingRequestMetadata, RequestMetadata } from "../../domain/request-types";
import { submittingRequestsPerWorkspaceHardCeiling } from "../../domain/safety-ceilings";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import {
  exactPreparedReplay,
  type PreparedContent,
  validatePendingPrivateContent,
  validatePreparedContent,
} from "./request-persistence-validation";
import { checkRequestCreateQuotas, checkRequestCycle } from "./request-quotas";
import {
  assertPendingWaitEdge,
  eraseRequestPrivateContent,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
  selectRequest,
} from "./request-repository-shared";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

interface PayloadRow extends RequestRow {
  readonly payloadJson: unknown;
  readonly envelopeJson: unknown;
  readonly retainedContentBytes: unknown;
  readonly creationOperationId: unknown;
}

export const requestSubmittingWorkspaceCountSql = `SELECT count(*) AS count
  FROM requests INDEXED BY requests_submitting_recovery
  WHERE workspace_key = ? AND delivery_state = 'submitting'`;

export class RequestRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  createPrepared(input: PrepareRequestInput): RequestStoreResult {
    if (!validateStartOperationId(input.creationOperationId).ok) {
      return { ok: false, code: "state_conflict" };
    }
    if (input.request.sourceSessionId === input.request.targetSessionId) {
      return { ok: false, code: "deadlock_detected" };
    }
    const content = validatePreparedContent(input.request, input.payloadJson, input.envelopeJson);
    if (input.request.workspaceKey !== this.context.workspaceKey || !content) {
      return { ok: false, code: "state_conflict" };
    }
    const atLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const rateNowMs = requestStoreNowMs(this.context);
        const replay = this.replayResult(input, content);
        if (replay) return replay;
        if (this.hasNativeCollision(input) || this.hasCreationOperationCollision(input)) {
          return { ok: false as const, code: "state_conflict" as const };
        }
        const rejected = this.admissionRejection(input, content, rateNowMs);
        if (rejected) return { ok: false as const, code: rejected };
        this.context.database.run(
          "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES (?, ?)",
          [input.request.workspaceKey, input.request.createdAtMs],
        );
        this.insertPrepared(input, content.retainedContentBytes, rateNowMs);
        const request = selectRequest(this.context, input.request.workspaceKey, input.request.id);
        if (!request) throw new StoreIntegrityError("A prepared request was not persisted.");
        return { ok: true as const, request };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  reconcilePreparedCreation(input: PrepareRequestInput): RequestCreationReconciliation {
    const content = validatePreparedContent(input.request, input.payloadJson, input.envelopeJson);
    if (
      input.request.workspaceKey !== this.context.workspaceKey ||
      !content ||
      !validateStartOperationId(input.creationOperationId).ok ||
      !validateFencingToken(input.fencingToken).ok
    )
      return { outcome: "conflict" };
    return this.context.database
      .transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const row = this.selectPayloadRow(input.request.workspaceKey, input.request.id);
        if (!row) {
          return this.hasCreationOperationCollision(input)
            ? { outcome: "conflict" as const }
            : { outcome: "absent" as const };
        }
        const existing = hydrateRequest(row);
        if (
          row.creationOperationId !== input.creationOperationId ||
          !hasRequestIdentity(snapshotRequestIdentity(input.request), existing)
        )
          return { outcome: "conflict" as const };
        if (
          existing.resolutionState === "pending" &&
          (row.retainedContentBytes !== content.retainedContentBytes ||
            !exactPreparedReplay(existing, input, row))
        )
          return { outcome: "conflict" as const };
        return { outcome: "matching" as const, request: existing };
      })
      .immediate();
  }

  private replayResult(
    input: PrepareRequestInput,
    content: PreparedContent,
  ): RequestStoreResult | undefined {
    const replay = this.selectPayloadRow(input.request.workspaceKey, input.request.id);
    if (!replay) return undefined;
    const existing = hydrateRequest(replay);
    return replay.creationOperationId === input.creationOperationId &&
      replay.retainedContentBytes === content.retainedContentBytes &&
      exactPreparedReplay(existing, input, replay)
      ? { ok: true, request: existing }
      : { ok: false, code: "state_conflict" };
  }

  private hasNativeCollision(input: PrepareRequestInput): boolean {
    return Boolean(
      this.context.database
        .query<{ readonly id: unknown }, [string, string]>(
          "SELECT id FROM requests WHERE workspace_key = ? AND native_message_id = ?",
        )
        .get(input.request.workspaceKey, input.request.nativeMessageId),
    );
  }

  private hasCreationOperationCollision(input: PrepareRequestInput): boolean {
    return Boolean(
      this.context.database
        .query<{ readonly id: unknown }, [string, string]>(
          "SELECT id FROM requests WHERE workspace_key = ? AND creation_operation_id = ?",
        )
        .get(input.request.workspaceKey, input.creationOperationId),
    );
  }

  private admissionRejection(
    input: PrepareRequestInput,
    content: PreparedContent,
    rateNowMs: number,
  ): "state_conflict" | "quota_exceeded" | "rate_limited" | "deadlock_detected" | undefined {
    if (input.request.createdAtMs > rateNowMs || rateNowMs >= input.request.deadlineAtMs) {
      return "state_conflict";
    }
    const quota = checkRequestCreateQuotas(
      this.context,
      input,
      content.retainedContentBytes,
      rateNowMs,
    );
    if (quota) return quota;
    const cycle = checkRequestCycle(this.context, input);
    if (cycle === "cycle") return "deadlock_detected";
    return cycle === "budget_exhausted" ? "quota_exceeded" : undefined;
  }

  private selectPayloadRow(workspace: string, id: string): PayloadRow | undefined {
    return (
      this.context.database
        .query<PayloadRow, [string, string]>(
          `SELECT ${requestMetadataColumns}, payload.payload_json AS payloadJson,
           payload.envelope_json AS envelopeJson,
           requests.creation_operation_id AS creationOperationId,
           requests.retained_content_byte_length AS retainedContentBytes
         FROM requests LEFT JOIN request_payloads AS payload ON payload.request_id = requests.id
         WHERE requests.workspace_key = ? AND requests.id = ?`,
        )
        .get(workspace, id) ?? undefined
    );
  }

  private insertPrepared(
    input: PrepareRequestInput,
    retainedBytes: number,
    rateNowMs: number,
  ): void {
    const request = input.request;
    this.context.database.run(
      `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
         native_message_id, creation_operation_id, kind, resolution_state, delivery_state, result_state,
         payload_byte_length, retained_content_byte_length, payload_sha256,
         created_at_ms, updated_at_ms, deadline_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'prepared', 'none', ?, ?, ?, ?, ?, ?)`,
      [
        request.id,
        request.workspaceKey,
        request.sourceSessionId,
        request.targetSessionId,
        request.nativeMessageId,
        input.creationOperationId,
        request.kind,
        request.payloadByteLength,
        retainedBytes,
        request.payloadSha256,
        request.createdAtMs,
        request.updatedAtMs,
        request.deadlineAtMs,
      ],
    );
    this.context.database.run(
      "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, ?, ?)",
      [request.id, input.payloadJson, input.envelopeJson],
    );
    this.context.database.run(
      `INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id)
       VALUES (?, ?, ?, ?)`,
      [request.id, request.workspaceKey, request.sourceSessionId, request.targetSessionId],
    );
    this.context.database.run(
      `INSERT INTO request_rate_events(workspace_key, source_session_id, target_session_id, occurred_at_ms)
       VALUES (?, ?, ?, ?)`,
      [request.workspaceKey, request.sourceSessionId, request.targetSessionId, rateNowMs],
    );
  }

  claimPrepared(input: RequestTransitionInput): RequestClaimResult {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateWorkspaceKey(input.workspaceKey).ok ||
      !validateRequestId(input.requestId).ok
    )
      return { ok: false, code: "state_conflict" };
    const atLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        return this.claimOwned(input, requestStoreNowMs(this.context));
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  reconcilePreparedClaim(input: RequestTransitionInput): RequestClaimReconciliation {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateWorkspaceKey(input.workspaceKey).ok ||
      !validateRequestId(input.requestId).ok ||
      !validateFencingToken(input.fencingToken).ok
    ) {
      return { outcome: "absent_or_other_claim" };
    }
    return this.context.database
      .transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const row = this.selectPayloadRow(input.workspaceKey, input.requestId);
        if (!row) return { outcome: "absent_or_other_claim" as const };
        const request = hydrateRequest(row);
        if (request.deliveryState === "prepared" && request.resolutionState === "pending") {
          return {
            outcome: "still_prepared" as const,
            request: request as PendingRequestMetadata & { readonly deliveryState: "prepared" },
          };
        }
        if (request.deliveryState !== "submitting" || request.resolutionState !== "pending")
          return { outcome: "settled" as const, request };
        const claim = this.context.database
          .query<{ readonly token: unknown }, [string, string]>(
            "SELECT claimed_fencing_token AS token FROM requests WHERE workspace_key = ? AND id = ?",
          )
          .get(input.workspaceKey, input.requestId);
        if (claim?.token !== input.fencingToken || typeof row.envelopeJson !== "string")
          return { outcome: "absent_or_other_claim" as const };
        const content = validatePendingPrivateContent(
          request,
          row.payloadJson,
          row.envelopeJson,
          row.retainedContentBytes,
        );
        if (!content)
          throw new StoreIntegrityError("A reconciled request claim had invalid private content.");
        return {
          outcome: "current_claim" as const,
          request: request as RequestMetadata & { readonly deliveryState: "submitting" },
          envelopeJson: content.envelopeJson,
        };
      })
      .immediate();
  }

  private claimOwned(input: RequestTransitionInput, storeNowMs: number): RequestClaimResult {
    const row = this.selectPayloadRow(input.workspaceKey, input.requestId);
    if (!row) return { ok: false, code: "state_conflict" };
    const before = hydrateRequest(row);
    if (before.deliveryState !== "prepared" || before.resolutionState !== "pending") {
      return { ok: true, request: before };
    }
    if (storeNowMs < before.updatedAtMs) return { ok: false, code: "state_conflict" };
    if (storeNowMs >= before.deadlineAtMs) {
      this.expireOne(before, storeNowMs);
      const expired = selectRequest(this.context, input.workspaceKey, input.requestId);
      if (!expired) throw new StoreIntegrityError("The expired request was absent.");
      return { ok: true, request: expired };
    }
    const content = validatePreparedContent(before, row.payloadJson, row.envelopeJson);
    if (!content || row.retainedContentBytes !== content.retainedContentBytes) {
      throw new StoreIntegrityError("Stored request content failed trust validation.");
    }
    assertPendingWaitEdge(this.context, before);
    const submitting = this.context.database
      .query<{ readonly count: number }, [string]>(requestSubmittingWorkspaceCountSql)
      .get(input.workspaceKey)?.count;
    if (!Number.isSafeInteger(submitting) || (submitting as number) < 0) {
      throw new StoreIntegrityError("The submitting request count was malformed.");
    }
    if ((submitting as number) >= submittingRequestsPerWorkspaceHardCeiling) {
      return { ok: false, code: "quota_exceeded" };
    }
    const changed = this.context.database.run(
      `UPDATE requests SET delivery_state = 'submitting', submitted_at_ms = ?, updated_at_ms = ?,
         claimed_fencing_token = ?
       WHERE workspace_key = ? AND id = ? AND delivery_state = 'prepared' AND resolution_state = 'pending'`,
      [storeNowMs, storeNowMs, input.fencingToken, input.workspaceKey, input.requestId],
    );
    if (changed.changes !== 1) throw new StoreIntegrityError("The request claim CAS failed.");
    const request = selectRequest(this.context, input.workspaceKey, input.requestId);
    if (request?.deliveryState !== "submitting") {
      throw new StoreIntegrityError("The request claim result was malformed.");
    }
    return { ok: true, request, envelopeJson: content.envelopeJson };
  }

  expireDueRequests(input: {
    readonly fencingToken: Parameters<RequestRepository["claimPrepared"]>[0]["fencingToken"];
    readonly workspaceKey: Parameters<RequestRepository["claimPrepared"]>[0]["workspaceKey"];
    readonly limit: number;
  }): ExpireDueRequestsResult {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      return { ok: false, code: "state_conflict" };
    const atLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const storeNowMs = requestStoreNowMs(this.context);
        return {
          ok: true as const,
          requests: this.expireDueOwned(input.workspaceKey, storeNowMs, input.limit),
        };
      });
      return transaction.immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  expireDueOwned(workspaceKey: string, storeNowMs: number, limit: number): RequestMetadata[] {
    const rows = this.context.database
      .query<RequestRow, [string, number, number]>(
        `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_deadline
         WHERE workspace_key = ? AND resolution_state = 'pending' AND deadline_at_ms <= ?
         ORDER BY deadline_at_ms, id LIMIT ?`,
      )
      .all(workspaceKey, storeNowMs, limit);
    return this.expireRowsOwned(workspaceKey, storeNowMs, rows);
  }

  expireDueForSourceOwned(
    workspaceKey: string,
    sourceSessionId: string,
    storeNowMs: number,
    limit: number,
  ): RequestMetadata[] {
    const rows = this.context.database
      .query<RequestRow, [string, string, number, number]>(
        `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_due_source
         WHERE workspace_key = ? AND source_session_id = ? AND resolution_state = 'pending'
           AND deadline_at_ms <= ? ORDER BY deadline_at_ms, id LIMIT ?`,
      )
      .all(workspaceKey, sourceSessionId, storeNowMs, limit);
    return this.expireRowsOwned(workspaceKey, storeNowMs, rows);
  }

  expireDueForTargetOwned(
    workspaceKey: string,
    targetSessionId: string,
    storeNowMs: number,
    limit: number,
  ): RequestMetadata[] {
    const rows = this.context.database
      .query<RequestRow, [string, string, number, number]>(
        `SELECT ${requestMetadataColumns} FROM requests INDEXED BY requests_due_target
         WHERE workspace_key = ? AND target_session_id = ? AND resolution_state = 'pending'
           AND deadline_at_ms <= ? ORDER BY deadline_at_ms, id LIMIT ?`,
      )
      .all(workspaceKey, targetSessionId, storeNowMs, limit);
    return this.expireRowsOwned(workspaceKey, storeNowMs, rows);
  }

  private expireRowsOwned(
    workspaceKey: string,
    storeNowMs: number,
    rows: readonly RequestRow[],
  ): RequestMetadata[] {
    const requests: RequestMetadata[] = [];
    for (const row of rows) {
      const before = hydrateRequest(row);
      this.expireOne(before, storeNowMs);
      const request = selectRequest(this.context, workspaceKey, before.id);
      if (!request) throw new StoreIntegrityError("An expired request was absent.");
      requests.push(request);
    }
    return requests;
  }

  expireExactDueOwned(
    workspaceKey: string,
    requestId: string,
    storeNowMs: number,
  ): RequestMetadata | undefined {
    const request = selectRequest(this.context, workspaceKey, requestId);
    if (request?.resolutionState !== "pending" || request.deadlineAtMs > storeNowMs)
      return undefined;
    this.expireOne(request, storeNowMs);
    return selectRequest(this.context, workspaceKey, requestId);
  }

  private expireOne(before: RequestMetadata, nowMs: number): void {
    eraseRequestPrivateContent(this.context, before.id);
    const changed = this.context.database.run(
      `UPDATE requests SET resolution_state = 'deadline_expired', resolved_at_ms = ?,
         updated_at_ms = MAX(updated_at_ms, ?), payload_sha256 = NULL,
         retained_content_byte_length = NULL
       WHERE workspace_key = ? AND id = ? AND resolution_state = 'pending' AND deadline_at_ms <= ?`,
      [nowMs, nowMs, before.workspaceKey, before.id, nowMs],
    );
    if (changed.changes !== 1) throw new StoreIntegrityError("The request expiry CAS failed.");
  }
}
