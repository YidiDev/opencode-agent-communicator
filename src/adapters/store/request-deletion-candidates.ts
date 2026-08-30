import type { ParticipantDeletionCandidatesResult } from "../../application/participant-deletion-ports";
import { participantDeletionCandidatesHardCeiling } from "../../domain/safety-ceilings";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import { requestFailure, requestPageLimitReached } from "./request-repository-shared";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export function listParticipantDeletionCandidates(
  context: StoreContext,
  ownership: OwnershipRepository,
  input: {
    readonly fencingToken: import("../../domain/ownership").FencingToken;
    readonly workspaceKey: WorkspaceKey;
  },
): ParticipantDeletionCandidatesResult {
  if (input.workspaceKey !== context.workspaceKey || !validateWorkspaceKey(input.workspaceKey).ok) {
    return { ok: false, code: "storage_unavailable" };
  }
  const atLimit = requestPageLimitReached(context);
  try {
    return context.database
      .transaction(() => {
        ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        const rows = context.database
          .query<{ readonly sessionId: unknown; readonly priority: unknown }, [string]>(
            `SELECT session_id AS sessionId, MIN(priority) AS priority FROM (
             SELECT target_session_id AS session_id, 0 AS priority FROM requests AS request
              WHERE workspace_key = ?1 AND resolution_state = 'pending'
                AND NOT (delivery_mode = 'initial' AND EXISTS (
                  SELECT 1 FROM start_operations AS start
                   WHERE start.workspace_key = request.workspace_key
                     AND start.id = request.linked_start_operation_id
                     AND start.session_id = request.target_session_id
                     AND start.creation_state IN ('prepared','submitting','outcome_unknown')
                ))
              UNION ALL
              SELECT target_session_id, 0 FROM context_admissions
               WHERE workspace_key = ?1 AND state = 'awaiting_context'
              UNION ALL
              SELECT source_session_id, 1 FROM requests
               WHERE workspace_key = ?1 AND resolution_state = 'pending'
              UNION ALL
              SELECT source_session_id, 1 FROM context_admissions
               WHERE workspace_key = ?1 AND state = 'awaiting_context'
              UNION ALL
              SELECT source_session_id, 2 FROM requests
              WHERE workspace_key = ?1 AND result_state = 'available'
                AND resolution_state IN ('answered','reached')
             UNION ALL
             SELECT session_id, 3 FROM managed_sessions
              WHERE workspace_key = ?1 AND provenance_state = 'created'
           ) GROUP BY session_id ORDER BY priority, session_id
           LIMIT ${participantDeletionCandidatesHardCeiling + 1}`,
          )
          .all(input.workspaceKey);
        if (rows.length > participantDeletionCandidatesHardCeiling) {
          throw new StoreIntegrityError(
            "Participant deletion candidates exceeded their hard bound.",
          );
        }
        const sessionIds = rows.map((row) => {
          const id = validateSessionId(row.sessionId);
          if (
            !id.ok ||
            !Number.isSafeInteger(row.priority) ||
            (row.priority as number) < 0 ||
            (row.priority as number) > 3
          ) {
            throw new StoreIntegrityError("Participant deletion candidate was malformed.");
          }
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
