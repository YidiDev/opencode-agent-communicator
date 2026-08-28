import type {
  PrepareRequestInput,
  RequestCreationReconciliation,
  RequestStoreResult,
} from "../../application/request-ports";
import { validateStartOperationId } from "../../domain/generated-ids";
import { validateFencingToken } from "../../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../../domain/request-identity";
import type { OwnershipRepository } from "./ownership-repository";
import {
  exactPreparedReplay,
  type PreparedContent,
  validatePreparedContent,
} from "./request-persistence-validation";
import { checkRequestCreateQuotas, checkRequestCycle } from "./request-quotas";
import {
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

export class RequestPreparationRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  createPrepared(input: PrepareRequestInput): RequestStoreResult {
    if (!validateStartOperationId(input.creationOperationId).ok)
      return { ok: false, code: "state_conflict" };
    if (input.request.sourceSessionId === input.request.targetSessionId)
      return { ok: false, code: "deadlock_detected" };
    const content = validatePreparedContent(input.request, input.payloadJson, input.envelopeJson);
    if (input.request.workspaceKey !== this.context.workspaceKey || !content)
      return { ok: false, code: "state_conflict" };
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          const rateNowMs = requestStoreNowMs(this.context);
          const replay = this.replayResult(input, content);
          if (replay) return replay;
          if (this.hasNativeCollision(input) || this.hasCreationOperationCollision(input))
            return { ok: false as const, code: "state_conflict" as const };
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
        })
        .immediate();
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
        if (!row)
          return this.hasCreationOperationCollision(input)
            ? { outcome: "conflict" as const }
            : { outcome: "absent" as const };
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
    if (input.request.createdAtMs > rateNowMs || rateNowMs >= input.request.deadlineAtMs)
      return "state_conflict";
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
       payload.envelope_json AS envelopeJson, requests.creation_operation_id AS creationOperationId,
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
      "INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id) VALUES (?, ?, ?, ?)",
      [request.id, request.workspaceKey, request.sourceSessionId, request.targetSessionId],
    );
    this.context.database.run(
      "INSERT INTO request_rate_events(workspace_key, source_session_id, target_session_id, occurred_at_ms) VALUES (?, ?, ?, ?)",
      [request.workspaceKey, request.sourceSessionId, request.targetSessionId, rateNowMs],
    );
  }
}
