import type {
  ContextAdmissionParticipantQueryPort,
  ContextAdmissionPersistencePort,
  ContextAdmissionStoreResult,
  ContextSnapshotItem,
  ParticipantContextAdmission,
  ParticipantContextPersistencePort,
  PrepareRequestContextAdmissionInput,
} from "../../application/context-admission-ports";
import { snapshotDenseArray } from "../../application/strict-port-boundaries";
import {
  type ContextAdmissionId,
  type ContextAdmissionMetadata,
  contextEnvelopeMaximumBytes,
} from "../../domain/context-admissions";
import { validateDeliveryId, validateRequestId } from "../../domain/generated-ids";
import type { FencingToken } from "../../domain/ownership";
import type { PendingRequestMetadata } from "../../domain/request-types";
import { participantDeletionCandidatesHardCeiling } from "../../domain/safety-ceilings";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey } from "../../domain/workspaces";
import {
  type ContextAdmissionRow,
  contextColumns,
  failContextAdmissionRows,
  hydrateContextAdmission,
  insertRequestContextAdmission,
  isExactContextEnvelope,
  selectContextAdmission,
  settleParticipantContextRows,
  snapshotItem,
} from "./context-admission-repository-shared";
import {
  checkContextMessageCreateQuotas,
  recordContextMessageRateEvent,
} from "./context-message-admission";
import type { OwnershipRepository } from "./ownership-repository";
import {
  eraseRequestPrivateContent,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
} from "./request-repository-shared";
import {
  type StoreContext,
  StoreIntegrityError,
  sqliteContextCollectionHardCeilings,
} from "./store-types";

export class ContextAdmissionRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  createMessage(
    input: Parameters<ContextAdmissionPersistencePort["createContextMessage"]>[0],
  ): ContextAdmissionStoreResult {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateWorkspaceKey(input.workspaceKey).ok ||
      !validateDeliveryId(input.id).ok ||
      !validateSessionId(input.sourceSessionId).ok ||
      !validateSessionId(input.targetSessionId).ok ||
      input.sourceSessionId === input.targetSessionId ||
      !Number.isSafeInteger(input.createdAtMs) ||
      input.createdAtMs < 0 ||
      !isExactContextEnvelope(input.envelopeJson, input.contentByteLength, input.contentSha256)
    ) {
      return { ok: false, code: "state_conflict" };
    }
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          const nowMs = requestStoreNowMs(this.context);
          if (nowMs < input.createdAtMs)
            return { ok: false as const, code: "state_conflict" as const };
          const quotaFailure = checkContextMessageCreateQuotas(this.context, input, nowMs);
          if (quotaFailure) return { ok: false as const, code: quotaFailure };
          this.context.database.run(
            "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES (?, ?)",
            [input.workspaceKey, input.createdAtMs],
          );
          this.context.database.run(
            `INSERT INTO context_admissions(
              id, kind, workspace_key, source_session_id, target_session_id, state, payload_json,
              content_byte_length, content_sha256, created_at_ms, updated_at_ms,
              awaiting_context_at_ms
            ) VALUES (?, 'message', ?, ?, ?, 'awaiting_context', ?, ?, ?, ?, ?, ?)`,
            [
              input.id,
              input.workspaceKey,
              input.sourceSessionId,
              input.targetSessionId,
              input.envelopeJson,
              input.contentByteLength,
              input.contentSha256,
              input.createdAtMs,
              nowMs,
              nowMs,
            ],
          );
          recordContextMessageRateEvent(this.context, input, nowMs);
          const admission = this.select(input.workspaceKey, input.id);
          if (!admission) throw new StoreIntegrityError("A context admission was not persisted.");
          return { ok: true as const, admission };
        })
        .immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  insertRequestInTransaction(
    request: PendingRequestMetadata,
    input: PrepareRequestContextAdmissionInput,
  ): void {
    insertRequestContextAdmission(this.context, request, input);
  }

  get(input: Parameters<ContextAdmissionPersistencePort["getContextAdmission"]>[0]) {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    if (input.workspaceKey !== this.context.workspaceKey) return undefined;
    return this.select(input.workspaceKey, input.id);
  }

  getForParticipant(
    input: Parameters<ContextAdmissionParticipantQueryPort["getContextAdmissionForParticipant"]>[0],
  ): ParticipantContextAdmission | undefined {
    if (input.workspaceKey !== this.context.workspaceKey) return undefined;
    const token = this.ownership.assertImplicitCurrent();
    this.ownership.assertOrdinaryWorkAllowed(token);
    const row = this.context.database
      .query<
        ContextAdmissionRow & { readonly role: unknown },
        [string, string, string, string, string]
      >(
        `SELECT ${contextColumns},
           CASE WHEN source_session_id = ? THEN 'source' ELSE 'target' END AS role
         FROM context_admissions WHERE workspace_key = ? AND id = ? AND kind = 'message'
           AND (source_session_id = ? OR target_session_id = ?)`,
      )
      .get(
        input.participantSessionId,
        input.workspaceKey,
        input.deliveryId,
        input.participantSessionId,
        input.participantSessionId,
      );
    if (!row) return undefined;
    if (row.role !== "source" && row.role !== "target") {
      throw new StoreIntegrityError("Stored context admission participant role was malformed.");
    }
    return { role: row.role, admission: hydrateContextAdmission(row) };
  }

  listPending(
    input: Parameters<ContextAdmissionPersistencePort["listPendingContext"]>[0],
  ): readonly ContextSnapshotItem[] {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateSessionId(input.targetSessionId).ok ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > sqliteContextCollectionHardCeilings.pendingEnvelopes ||
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes < 1 ||
      input.maximumBytes > contextEnvelopeMaximumBytes
    ) {
      return [];
    }
    const rows = this.context.database
      .query<ContextAdmissionRow, [string, string, number]>(
        `SELECT ${contextColumns}, payload_json AS payloadJson FROM context_admissions
         WHERE workspace_key = ? AND target_session_id = ? AND state = 'awaiting_context'
         ORDER BY created_at_ms, id LIMIT ?`,
      )
      .all(input.workspaceKey, input.targetSessionId, input.limit);
    const result: ContextSnapshotItem[] = [];
    let bytes = 0;
    for (const row of rows) {
      const admission = hydrateContextAdmission(row);
      if (
        typeof row.payloadJson !== "string" ||
        !isExactContextEnvelope(
          row.payloadJson,
          admission.contentByteLength,
          admission.contentSha256,
        )
      ) {
        throw new StoreIntegrityError("Stored context payload failed trust validation.");
      }
      if (bytes + admission.contentByteLength > input.maximumBytes) break;
      bytes += admission.contentByteLength;
      result.push(snapshotItem(admission, row.payloadJson));
    }
    return result;
  }

  claim(
    input: Parameters<ContextAdmissionPersistencePort["claimPendingContext"]>[0],
  ): readonly ContextAdmissionMetadata[] {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateSessionId(input.targetSessionId).ok ||
      input.items.length < 1 ||
      input.items.length > sqliteContextCollectionHardCeilings.claimedEnvelopes
    ) {
      return [];
    }
    return this.context.database
      .transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const nowMs = requestStoreNowMs(this.context);
        const unique = new Set<string>();
        for (const item of input.items) {
          if (unique.has(item.id))
            throw new StoreIntegrityError("A context claim contained duplicates.");
          unique.add(item.id);
          const row = this.context.database
            .query<ContextAdmissionRow, [string, string, string, string]>(
              `SELECT ${contextColumns} FROM context_admissions
               WHERE workspace_key = ? AND target_session_id = ? AND id = ? AND content_sha256 = ?
                 AND state = 'awaiting_context'`,
            )
            .get(input.workspaceKey, input.targetSessionId, item.id, item.contentSha256);
          if (!row || hydrateContextAdmission(row).kind !== item.kind) return [];
        }
        const admitted: ContextAdmissionMetadata[] = [];
        for (const item of input.items) {
          const changed = this.context.database.run(
            `UPDATE context_admissions SET state = 'context_admitted', payload_json = NULL,
               context_admitted_at_ms = ?, updated_at_ms = ?, claimed_fencing_token = ?
             WHERE workspace_key = ? AND target_session_id = ? AND id = ?
               AND content_sha256 = ? AND state = 'awaiting_context'`,
            [
              nowMs,
              nowMs,
              input.fencingToken,
              input.workspaceKey,
              input.targetSessionId,
              item.id,
              item.contentSha256,
            ],
          );
          if (changed.changes !== 1) throw new StoreIntegrityError("The context claim CAS failed.");
          const admission = this.select(input.workspaceKey, item.id);
          if (admission?.state !== "context_admitted") {
            throw new StoreIntegrityError("The context claim result was malformed.");
          }
          admitted.push(admission);
        }
        return admitted;
      })
      .immediate();
  }

  readReminders(input: Parameters<ContextAdmissionPersistencePort["readContextReminders"]>[0]) {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateSessionId(input.targetSessionId).ok ||
      !Number.isSafeInteger(input.resultLimit) ||
      input.resultLimit < 1 ||
      input.resultLimit > sqliteContextCollectionHardCeilings.resultReminders
    ) {
      return { activeLockCount: 0, availableResults: [] };
    }
    const nowMs = requestStoreNowMs(this.context);
    const activeLockCount = this.context.database
      .query<{ readonly count: number }, [string, number]>(
        "SELECT count(*) AS count FROM advisory_locks WHERE workspace_key = ? AND expires_at_ms > ?",
      )
      .get(input.workspaceKey, nowMs)?.count;
    if (!Number.isSafeInteger(activeLockCount) || (activeLockCount as number) < 0) {
      throw new StoreIntegrityError("The context lock reminder count was malformed.");
    }
    const availableResults = this.context.database
      .query<{ readonly requestId: unknown; readonly kind: unknown }, [string, string, number]>(
        `SELECT id AS requestId, kind FROM requests
         WHERE workspace_key = ? AND source_session_id = ? AND result_state = 'available'
         ORDER BY result_available_at_ms, id LIMIT ?`,
      )
      .all(input.workspaceKey, input.targetSessionId, input.resultLimit)
      .map((row) => {
        const id = validateRequestId(row.requestId);
        if (!id.ok || (row.kind !== "ask" && row.kind !== "wait")) {
          throw new StoreIntegrityError("A context result reminder was malformed.");
        }
        return { requestId: id.value, kind: row.kind as "ask" | "wait" };
      });
    return { activeLockCount: activeLockCount as number, availableResults };
  }

  cancel(
    input: Parameters<ContextAdmissionPersistencePort["cancelContextAdmission"]>[0],
  ): ContextAdmissionStoreResult {
    return this.settleOne(input, "cancelled");
  }

  failForTarget(
    input: Parameters<ContextAdmissionPersistencePort["failPendingContextForParticipant"]>[0],
  ): readonly ContextAdmissionMetadata[] {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateSessionId(input.participantSessionId).ok ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      return [];
    }
    return this.context.database
      .transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const nowMs = requestStoreNowMs(this.context);
        const rows = this.context.database
          .query<ContextAdmissionRow, [string, string, string, number]>(
            `SELECT ${contextColumns} FROM context_admissions
             WHERE workspace_key = ? AND (target_session_id = ? OR source_session_id = ?)
               AND state = 'awaiting_context'
             ORDER BY created_at_ms, id LIMIT ?`,
          )
          .all(
            input.workspaceKey,
            input.participantSessionId,
            input.participantSessionId,
            input.limit,
          );
        return failContextAdmissionRows(
          this.context,
          rows,
          input.workspaceKey,
          input.fencingToken,
          nowMs,
        );
      })
      .immediate();
  }

  settleForParticipant(
    input: Parameters<ParticipantContextPersistencePort["settlePendingContextForParticipant"]>[0],
  ): readonly ContextAdmissionMetadata[] {
    const terminalValues = snapshotDenseArray(
      input.terminalParticipantSessionIds,
      participantDeletionCandidatesHardCeiling,
    );
    const terminalIds = new Set<string>();
    if (terminalValues) {
      for (const value of terminalValues) {
        const id = validateSessionId(value);
        if (!id.ok || terminalIds.has(id.value)) {
          throw new StoreIntegrityError("Participant context terminal set was malformed.");
        }
        terminalIds.add(id.value);
      }
    }
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateSessionId(input.participantSessionId).ok ||
      !terminalValues ||
      !terminalIds.has(input.participantSessionId) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new StoreIntegrityError("Participant context settlement input was malformed.");
    }
    return this.context.database
      .transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const nowMs = requestStoreNowMs(this.context);
        const rows = this.context.database
          .query<ContextAdmissionRow, [string, string, string, number]>(
            `SELECT ${contextColumns} FROM context_admissions
             WHERE workspace_key = ? AND (target_session_id = ? OR source_session_id = ?)
               AND state = 'awaiting_context'
             ORDER BY created_at_ms, id LIMIT ?`,
          )
          .all(
            input.workspaceKey,
            input.participantSessionId,
            input.participantSessionId,
            input.limit,
          );
        return settleParticipantContextRows(
          this.context,
          rows,
          input.workspaceKey,
          input.fencingToken,
          nowMs,
          terminalIds,
        );
      })
      .immediate();
  }

  failUncertainOnStartup(
    input: Parameters<ContextAdmissionPersistencePort["failUncertainContextOnStartup"]>[0],
  ): readonly ContextAdmissionMetadata[] {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      return [];
    }
    return this.context.database
      .transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const nowMs = requestStoreNowMs(this.context);
        const rows = this.context.database
          .query<ContextAdmissionRow, [string, number]>(
            `SELECT ${contextColumns} FROM context_admissions
             WHERE workspace_key = ? AND state = 'awaiting_context'
             ORDER BY created_at_ms, id LIMIT ?`,
          )
          .all(input.workspaceKey, input.limit);
        return failContextAdmissionRows(
          this.context,
          rows,
          input.workspaceKey,
          input.fencingToken,
          nowMs,
        );
      })
      .immediate();
  }

  private settleOne(
    input: {
      readonly fencingToken: FencingToken;
      readonly workspaceKey: string;
      readonly id: ContextAdmissionId;
    },
    state: "cancelled",
  ): ContextAdmissionStoreResult {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          const nowMs = requestStoreNowMs(this.context);
          const changed = this.context.database.run(
            `UPDATE context_admissions SET state = ?, payload_json = NULL, cancelled_at_ms = ?,
               updated_at_ms = ? WHERE workspace_key = ? AND id = ?
               AND state IN ('prepared','awaiting_context')`,
            [state, nowMs, nowMs, input.workspaceKey, input.id],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          const admission = this.select(input.workspaceKey, input.id);
          if (!admission) throw new StoreIntegrityError("A settled context admission was absent.");
          if (admission.kind === "request") {
            eraseRequestPrivateContent(this.context, admission.id);
            const parent = this.context.database.run(
              `UPDATE requests SET delivery_state = 'delivery_failed', resolution_state = 'cancelled',
                 submitted_at_ms = ?, delivery_failed_at_ms = ?, resolved_at_ms = ?, updated_at_ms = ?,
                 claimed_fencing_token = ?, retained_content_byte_length = NULL, payload_sha256 = NULL
               WHERE workspace_key = ? AND id = ? AND resolution_state = 'pending'`,
              [nowMs, nowMs, nowMs, nowMs, input.fencingToken, input.workspaceKey, admission.id],
            );
            if (parent.changes !== 1) {
              throw new StoreIntegrityError(
                "A cancelled context request parent was not terminalized.",
              );
            }
          }
          return { ok: true as const, admission };
        })
        .immediate();
    } catch (cause: unknown) {
      return requestFailure(cause, atLimit);
    }
  }

  private select(
    workspaceKey: string,
    id: ContextAdmissionId,
  ): ContextAdmissionMetadata | undefined {
    return selectContextAdmission(this.context, workspaceKey, id);
  }
}
