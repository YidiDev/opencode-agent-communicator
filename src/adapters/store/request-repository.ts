import type {
  ExpireDueRequestsResult,
  PrepareRequestInput,
  RequestClaimReconciliation,
  RequestClaimResult,
  RequestCreationReconciliation,
  RequestStoreResult,
  RequestTransitionInput,
} from "../../application/request-ports";
import { validateRequestId } from "../../domain/generated-ids";
import { validateFencingToken } from "../../domain/ownership";
import type { PendingRequestMetadata, RequestMetadata } from "../../domain/request-types";
import { submittingRequestsPerWorkspaceHardCeiling } from "../../domain/safety-ceilings";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import {
  validatePendingPrivateContent,
  validatePreparedContent,
} from "./request-persistence-validation";
import { RequestPreparationRepository } from "./request-preparation-repository";
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
  private readonly preparation: RequestPreparationRepository;

  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {
    this.preparation = new RequestPreparationRepository(context, ownership);
  }

  createPrepared(input: PrepareRequestInput): RequestStoreResult {
    return this.preparation.createPrepared(input);
  }

  createPreparedInTransaction(input: PrepareRequestInput): RequestStoreResult {
    return this.preparation.createPreparedInTransaction(input);
  }

  getRequestMetadata(input: RequestTransitionInput): RequestMetadata | undefined {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    if (input.workspaceKey !== this.context.workspaceKey || !validateRequestId(input.requestId).ok)
      return undefined;
    return selectRequest(this.context, input.workspaceKey, input.requestId);
  }

  getRequestMetadataForRecovery(input: RequestTransitionInput): RequestMetadata | undefined {
    this.ownership.assertCurrent(input.fencingToken);
    if (input.workspaceKey !== this.context.workspaceKey || !validateRequestId(input.requestId).ok)
      return undefined;
    return selectRequest(this.context, input.workspaceKey, input.requestId);
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

  reconcilePreparedCreation(input: PrepareRequestInput): RequestCreationReconciliation {
    return this.preparation.reconcilePreparedCreation(input);
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
