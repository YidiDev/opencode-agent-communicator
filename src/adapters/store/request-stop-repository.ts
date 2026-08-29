import type {
  ParticipantStopCandidatesResult,
  ParticipantStopPersistencePort,
} from "../../application/participant-stop-ports";
import type {
  SessionStopPersistencePort,
  StopPendingRequestsResult,
} from "../../application/session-stop-ports";
import {
  participantStopCandidatesHardCeiling,
  pendingRequestsPerWorkspaceHardCeiling,
} from "../../domain/safety-ceilings";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import {
  assertPendingWaitEdge,
  assertTerminalPrivateState,
  requestFailure,
  requestPageLimitReached,
  requestStoreNowMs,
} from "./request-repository-shared";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export class RequestStopRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  stopPendingRequests(
    input: Parameters<SessionStopPersistencePort["stopPendingRequests"]>[0],
  ): StopPendingRequestsResult {
    return this.stop(input, false);
  }

  stopPendingBlockingRequests(
    input: Parameters<SessionStopPersistencePort["stopPendingRequests"]>[0],
  ): StopPendingRequestsResult {
    return this.stop(input, true);
  }

  listParticipantStopCandidates(
    input: Parameters<ParticipantStopPersistencePort["listParticipantStopCandidates"]>[0],
  ): ParticipantStopCandidatesResult {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateWorkspaceKey(input.workspaceKey).ok
    ) {
      return { ok: false, code: "storage_unavailable" };
    }
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          const nowMs = requestStoreNowMs(this.context);
          const rows = this.context.database
            .query<{ readonly sessionId: unknown }, [string, number]>(
              `SELECT session_id AS sessionId FROM (
                 SELECT target_session_id AS session_id FROM requests
                  WHERE workspace_key = ?1 AND resolution_state = 'pending'
                    AND delivery_mode = 'steer' AND deadline_at_ms > ?2
                 UNION
                 SELECT source_session_id AS session_id FROM requests
                  WHERE workspace_key = ?1 AND resolution_state = 'pending'
                    AND delivery_mode = 'steer' AND deadline_at_ms > ?2
               ) ORDER BY session_id LIMIT ${participantStopCandidatesHardCeiling + 1}`,
            )
            .all(input.workspaceKey, nowMs);
          if (rows.length > participantStopCandidatesHardCeiling) {
            throw new StoreIntegrityError("Participant stop candidates exceeded their hard bound.");
          }
          const sessionIds = rows.map((row) => {
            const id = validateSessionId(row.sessionId);
            if (!id.ok) throw new StoreIntegrityError("Participant stop candidate was malformed.");
            return id.value;
          });
          return { ok: true as const, sessionIds: Object.freeze(sessionIds) };
        })
        .immediate();
    } catch (cause: unknown) {
      const failure = requestFailure(cause, atLimit);
      return {
        ok: false,
        code: failure.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
      };
    }
  }

  private stop(
    input: Parameters<SessionStopPersistencePort["stopPendingRequests"]>[0],
    blockingOnly: boolean,
  ): StopPendingRequestsResult {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validateWorkspaceKey(input.workspaceKey).ok ||
      !validateSessionId(input.stoppedSessionId).ok
    ) {
      return { ok: false, code: "storage_unavailable" };
    }
    const atLimit = requestPageLimitReached(this.context);
    try {
      return this.context.database
        .transaction(() => this.stopOwned(input, blockingOnly))
        .immediate();
    } catch (cause: unknown) {
      const failure = requestFailure(cause, atLimit);
      return {
        ok: false,
        code: failure.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
      };
    }
  }

  private stopOwned(
    input: Parameters<SessionStopPersistencePort["stopPendingRequests"]>[0],
    blockingOnly: boolean,
  ): StopPendingRequestsResult {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    const scope = blockingOnly ? " AND delivery_mode = 'steer'" : "";
    const nowMs = requestStoreNowMs(this.context);
    const rows = this.context.database
      .query<RequestRow, [string, string, number]>(
        `SELECT ${requestMetadataColumns} FROM requests
         WHERE workspace_key = ? AND resolution_state = 'pending'
           AND (target_session_id = ?2 OR source_session_id = ?2)
           AND deadline_at_ms > ?3
           ${scope}
         ORDER BY id LIMIT ${pendingRequestsPerWorkspaceHardCeiling + 1}`,
      )
      .all(input.workspaceKey, input.stoppedSessionId, nowMs);
    if (rows.length > pendingRequestsPerWorkspaceHardCeiling) {
      throw new StoreIntegrityError("Pending stop notification metadata exceeded its hard bound.");
    }
    if (rows.length === 0) return { ok: true, terminalized: Object.freeze([]) };
    const requests = rows.map(hydrateRequest);
    for (const request of requests) {
      if (request.resolutionState !== "pending" || nowMs < request.updatedAtMs) {
        throw new StoreIntegrityError("Pending stop candidate was incoherent.");
      }
      assertPendingWaitEdge(this.context, request);
      const payload = this.context.database
        .query<{ readonly count: number }, [string]>(
          "SELECT count(*) AS count FROM request_payloads WHERE request_id = ?",
        )
        .get(request.id);
      if (payload?.count !== 1) {
        throw new StoreIntegrityError("Pending stop candidate payload was invalid.");
      }
    }
    this.context.database.run(
      `DELETE FROM request_results WHERE request_id IN (
         SELECT id FROM requests WHERE workspace_key = ? AND resolution_state = 'pending'
           AND (target_session_id = ?2 OR source_session_id = ?2)
           AND deadline_at_ms > ?3
           ${scope}
        )`,
      [input.workspaceKey, input.stoppedSessionId, nowMs],
    );
    this.context.database.run(
      `DELETE FROM request_payloads WHERE request_id IN (
         SELECT id FROM requests WHERE workspace_key = ? AND resolution_state = 'pending'
           AND (target_session_id = ?2 OR source_session_id = ?2)
           AND deadline_at_ms > ?3
           ${scope}
        )`,
      [input.workspaceKey, input.stoppedSessionId, nowMs],
    );
    this.context.database.run(
      `DELETE FROM request_wait_edges WHERE request_id IN (
         SELECT id FROM requests WHERE workspace_key = ? AND resolution_state = 'pending'
           AND (target_session_id = ?2 OR source_session_id = ?2)
           AND deadline_at_ms > ?3
           ${scope}
        )`,
      [input.workspaceKey, input.stoppedSessionId, nowMs],
    );
    const changed = this.context.database.run(
      `UPDATE requests SET
         resolution_state = CASE WHEN target_session_id = ?2 THEN 'target_stopped' ELSE 'source_stopped' END,
         resolved_at_ms = ?3, updated_at_ms = ?3, payload_sha256 = NULL,
         retained_content_byte_length = NULL, result_state = 'none', result_byte_length = NULL,
         result_sha256 = NULL, result_available_at_ms = NULL, result_expires_at_ms = NULL,
         result_expired_at_ms = NULL, acknowledged_at_ms = NULL
        WHERE workspace_key = ?1 AND resolution_state = 'pending'
          AND (target_session_id = ?2 OR source_session_id = ?2)
          AND deadline_at_ms > ?3
          ${scope}`,
      [input.workspaceKey, input.stoppedSessionId, nowMs],
    );
    if (changed.changes !== requests.length) {
      throw new StoreIntegrityError(
        "Atomic request stop terminalization changed an unexpected count.",
      );
    }
    const terminalized = requests.map((request) => {
      assertTerminalPrivateState(this.context, request.id);
      const row = this.context.database
        .query<RequestRow, [string, string]>(
          `SELECT ${requestMetadataColumns} FROM requests WHERE workspace_key = ? AND id = ?`,
        )
        .get(input.workspaceKey, request.id);
      if (!row) throw new StoreIntegrityError("Stopped request metadata was absent.");
      const stopped = hydrateRequest(row);
      if (
        stopped.resolutionState !==
        (stopped.targetSessionId === input.stoppedSessionId ? "target_stopped" : "source_stopped")
      ) {
        throw new StoreIntegrityError("Stopped request role outcome was incoherent.");
      }
      return Object.freeze(stopped);
    });
    return { ok: true, terminalized: Object.freeze(terminalized) };
  }
}
