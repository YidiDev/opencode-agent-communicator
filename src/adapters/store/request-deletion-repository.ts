import type {
  DeleteParticipantRequestsResult,
  ParticipantDeletionPersistencePort,
} from "../../application/participant-deletion-ports";
import { snapshotDenseArray } from "../../application/strict-port-boundaries";
import {
  availableResultsPerWorkspaceHardCeiling,
  managedSessionsPerWorkspaceHardCeiling,
  participantDeletionCandidatesHardCeiling,
  pendingRequestsPerWorkspaceHardCeiling,
} from "../../domain/safety-ceilings";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import { listParticipantDeletionCandidates } from "./request-deletion-candidates";
import { validatePendingPrivateContent } from "./request-persistence-validation";
import {
  assertPendingWaitEdge,
  assertTerminalPrivateState,
  eraseStoredResult,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
} from "./request-repository-shared";
import { validateStoredResultState } from "./request-result-validation";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export class RequestDeletionRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  listParticipantDeletionCandidates(input: {
    readonly fencingToken: import("../../domain/ownership").FencingToken;
    readonly workspaceKey: import("../../domain/workspaces").WorkspaceKey;
  }): import("../../application/participant-deletion-ports").ParticipantDeletionCandidatesResult {
    return listParticipantDeletionCandidates(this.context, this.ownership, input);
  }

  deleteParticipantRequests(
    input: Parameters<ParticipantDeletionPersistencePort["deleteParticipantRequests"]>[0],
  ): DeleteParticipantRequestsResult {
    return this.deleteAbsent({
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      absentSessionIds: [input.deletedSessionId],
    });
  }

  deleteAbsent(
    input: Parameters<ParticipantDeletionPersistencePort["deleteAbsentParticipantRequests"]>[0],
  ): DeleteParticipantRequestsResult {
    const absentSessionIds = this.validateAbsentSessionIds(input.absentSessionIds);
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateWorkspaceKey(input.workspaceKey).ok ||
      !absentSessionIds
    )
      return { ok: false, code: "storage_unavailable" };
    const atLimit = requestPageLimitReached(this.context);
    try {
      const absentJson = JSON.stringify(absentSessionIds);
      return this.context.database
        .transaction(() => this.deleteOwned(input, absentJson, new Set(absentSessionIds)))
        .immediate();
    } catch (cause: unknown) {
      const failure = requestFailure(cause, atLimit);
      return {
        ok: false,
        code: failure.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
      };
    }
  }

  private deleteOwned(
    input: Parameters<ParticipantDeletionPersistencePort["deleteAbsentParticipantRequests"]>[0],
    absentJson: string,
    absentSessionIds: ReadonlySet<string>,
  ): DeleteParticipantRequestsResult {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    const nowMs = requestStoreNowMs(this.context);
    this.retireManagedSessions(input.workspaceKey, absentJson);
    this.eraseAvailableSourceResults(input.workspaceKey, absentJson, absentSessionIds, nowMs);
    const rows = this.context.database
      .query<RequestRow, [string, string]>(
        `SELECT ${requestMetadataColumns} FROM requests
         WHERE workspace_key = ?1 AND resolution_state = 'pending'
           AND (target_session_id IN (SELECT value FROM json_each(?2))
             OR source_session_id IN (SELECT value FROM json_each(?2)))
         ORDER BY id LIMIT ${pendingRequestsPerWorkspaceHardCeiling + 1}`,
      )
      .all(input.workspaceKey, absentJson);
    /* istanbul ignore next -- the schema quota makes the residual row corruption-only */
    if (rows.length > pendingRequestsPerWorkspaceHardCeiling)
      throw new StoreIntegrityError("Pending deletion metadata exceeded its hard bound.");
    if (rows.length === 0) return { ok: true, terminalized: Object.freeze([]) };
    const requests = rows.map(hydrateRequest);
    for (const request of requests) {
      if (request.resolutionState !== "pending" || nowMs < request.updatedAtMs)
        throw new StoreIntegrityError("Pending deletion candidate was incoherent.");
      assertPendingWaitEdge(this.context, request);
      const privateRows = this.context.database
        .query<
          {
            readonly payloads: number;
            readonly results: number;
            readonly payloadJson: unknown;
            readonly envelopeJson: unknown;
            readonly retainedBytes: unknown;
          },
          [string]
        >(
          `SELECT
              (SELECT count(*) FROM request_payloads WHERE request_id = ?1) AS payloads,
              (SELECT count(*) FROM request_results WHERE request_id = ?1) AS results,
              (SELECT payload_json FROM request_payloads WHERE request_id = ?1) AS payloadJson,
              (SELECT envelope_json FROM request_payloads WHERE request_id = ?1) AS envelopeJson,
              retained_content_byte_length AS retainedBytes
            FROM requests WHERE id = ?1`,
        )
        .get(request.id);
      if (
        privateRows?.payloads !== 1 ||
        privateRows.results !== 0 ||
        !validatePendingPrivateContent(
          request,
          privateRows.payloadJson,
          privateRows.envelopeJson,
          privateRows.retainedBytes,
        )
      )
        throw new StoreIntegrityError("Pending deletion candidate private state was invalid.");
    }
    for (const table of ["request_results", "request_payloads", "request_wait_edges"] as const)
      this.context.database.run(
        `DELETE FROM ${table} WHERE request_id IN (
           SELECT id FROM requests WHERE workspace_key = ?1 AND resolution_state = 'pending'
             AND (target_session_id IN (SELECT value FROM json_each(?2))
               OR source_session_id IN (SELECT value FROM json_each(?2)))
          )`,
        [input.workspaceKey, absentJson],
      );
    const changed = this.context.database.run(
      `UPDATE requests SET
         resolution_state = CASE
           WHEN target_session_id IN (SELECT value FROM json_each(?2))
             THEN 'target_deleted' ELSE 'source_deleted' END,
         resolved_at_ms = ?3, updated_at_ms = ?3, payload_sha256 = NULL,
         retained_content_byte_length = NULL, result_state = 'none', result_byte_length = NULL,
         result_sha256 = NULL, result_available_at_ms = NULL, result_expires_at_ms = NULL,
         result_expired_at_ms = NULL, acknowledged_at_ms = NULL
       WHERE workspace_key = ?1 AND resolution_state = 'pending'
         AND (target_session_id IN (SELECT value FROM json_each(?2))
           OR source_session_id IN (SELECT value FROM json_each(?2)))`,
      [input.workspaceKey, absentJson, nowMs],
    );
    if (changed.changes !== requests.length)
      throw new StoreIntegrityError("Atomic request deletion changed an unexpected count.");
    const terminalized = requests.map((request) => {
      assertTerminalPrivateState(this.context, request.id);
      const row = this.context.database
        .query<RequestRow, [string, string]>(
          `SELECT ${requestMetadataColumns} FROM requests WHERE workspace_key = ? AND id = ?`,
        )
        .get(input.workspaceKey, request.id);
      if (!row) throw new StoreIntegrityError("Deleted participant request metadata was absent.");
      const deleted = hydrateRequest(row);
      const expected = absentSessionIds.has(deleted.targetSessionId)
        ? "target_deleted"
        : absentSessionIds.has(deleted.sourceSessionId)
          ? "source_deleted"
          : undefined;
      if (deleted.resolutionState !== expected)
        throw new StoreIntegrityError("Deleted participant role outcome was incoherent.");
      return Object.freeze(deleted);
    });
    return { ok: true, terminalized: Object.freeze(terminalized) };
  }

  private retireManagedSessions(workspaceKey: string, absentJson: string): void {
    const rows = this.context.database
      .query<{ readonly sessionId: unknown }, [string, string]>(
        `SELECT session_id AS sessionId FROM managed_sessions
         WHERE workspace_key = ?1 AND provenance_state = 'created'
           AND session_id IN (SELECT value FROM json_each(?2))
         ORDER BY session_id LIMIT ${managedSessionsPerWorkspaceHardCeiling + 1}`,
      )
      .all(workspaceKey, absentJson);
    /* istanbul ignore next -- the managed-session schema quota enforces this ceiling */
    if (rows.length > managedSessionsPerWorkspaceHardCeiling)
      throw new StoreIntegrityError("Managed-session deletion provenance exceeded its hard bound.");
    const createdSessionIds = rows.map((row) => {
      const sessionId = validateSessionId(row.sessionId);
      /* istanbul ignore next -- managed-session CHECK constraints enforce canonical IDs */
      if (!sessionId.ok)
        throw new StoreIntegrityError("Managed-session deletion provenance was malformed.");
      return sessionId.value;
    });
    this.context.database.run(
      `UPDATE managed_sessions SET provenance_state = 'deleted'
       WHERE workspace_key = ?1 AND provenance_state = 'created'
         AND session_id IN (SELECT value FROM json_each(?2))`,
      [workspaceKey, absentJson],
    );
    const row = this.context.database
      .query<{ readonly remaining: number }, [string, string]>(
        `SELECT count(*) AS remaining FROM managed_sessions
         WHERE workspace_key = ?1 AND provenance_state <> 'deleted'
           AND session_id IN (SELECT value FROM json_each(?2))`,
      )
      .get(workspaceKey, JSON.stringify(createdSessionIds));
    if (row?.remaining !== 0) {
      throw new StoreIntegrityError("Managed-session deletion provenance was not retired.");
    }
  }

  private eraseAvailableSourceResults(
    workspaceKey: string,
    absentJson: string,
    absentSessionIds: ReadonlySet<string>,
    nowMs: number,
  ): void {
    const rows = this.context.database
      .query<RequestRow, [string, string]>(
        `SELECT ${requestMetadataColumns} FROM requests
         WHERE workspace_key = ?1
           AND source_session_id IN (SELECT value FROM json_each(?2))
           AND result_state = 'available'
           AND resolution_state IN ('answered','reached')
         ORDER BY id LIMIT ${availableResultsPerWorkspaceHardCeiling + 1}`,
      )
      .all(workspaceKey, absentJson);
    if (rows.length > availableResultsPerWorkspaceHardCeiling) {
      throw new StoreIntegrityError("Deleted source result metadata exceeded its hard bound.");
    }
    for (const row of rows) {
      const request = hydrateRequest(row);
      validateStoredResultState(this.context, request);
      if (
        !absentSessionIds.has(request.sourceSessionId) ||
        request.resultState !== "available" ||
        (request.resolutionState !== "answered" && request.resolutionState !== "reached")
      ) {
        throw new StoreIntegrityError("Deleted source result metadata was incoherent.");
      }
      eraseStoredResult(this.context, request.id);
      // Existing result metadata defines expiry as no earlier than its retention deadline. Erasure
      // is immediate; the historical timestamp remains schema-coherent without changing resolution.
      const expiredAtMs = Math.max(nowMs, request.resultExpiresAtMs);
      const changed = this.context.database.run(
        `UPDATE requests SET result_state = 'expired', result_expired_at_ms = ?,
           updated_at_ms = MAX(updated_at_ms, ?), result_byte_length = NULL, result_sha256 = NULL
          WHERE workspace_key = ? AND id = ? AND source_session_id = ?
           AND result_state = 'available' AND resolution_state IN ('answered','reached')`,
        [expiredAtMs, expiredAtMs, workspaceKey, request.id, request.sourceSessionId],
      );
      if (changed.changes !== 1) {
        throw new StoreIntegrityError("Deleted source result erasure CAS failed.");
      }
      const after = this.context.database
        .query<RequestRow, [string, string]>(
          `SELECT ${requestMetadataColumns} FROM requests WHERE workspace_key = ? AND id = ?`,
        )
        .get(workspaceKey, request.id);
      if (!after) throw new StoreIntegrityError("Erased source result metadata was absent.");
      const erased = hydrateRequest(after);
      validateStoredResultState(this.context, erased);
      if (erased.resolutionState !== request.resolutionState || erased.resultState !== "expired") {
        throw new StoreIntegrityError("Erased source result outcome changed incoherently.");
      }
    }
  }

  private validateAbsentSessionIds(value: unknown): readonly string[] | undefined {
    const values = snapshotDenseArray(value, participantDeletionCandidatesHardCeiling);
    if (!values) return undefined;
    const seen = new Set<string>();
    const sessionIds: string[] = [];
    for (const value of values) {
      const sessionId = validateSessionId(value);
      if (!sessionId.ok || seen.has(sessionId.value)) return undefined;
      seen.add(sessionId.value);
      sessionIds.push(sessionId.value);
    }
    return Object.freeze(sessionIds);
  }
}
