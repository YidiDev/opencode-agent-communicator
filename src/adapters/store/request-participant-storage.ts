import type { RequestListBoundary } from "../../application/request-list-cursor";
import type { ParticipantRequestMetadata } from "../../application/request-ports";
import { hydrateParticipantRole, type RoleRow } from "./request-participant-projection";
import { requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

export function authorizeParticipant(
  context: StoreContext,
  workspace: string,
  requestId: string,
  caller: string,
): "source" | "target" | undefined {
  const row = context.database
    .query<{ readonly participantRole: unknown }, [string, string, string, string]>(
      `SELECT CASE WHEN source_session_id = ?3 THEN 'source' ELSE 'target' END AS participantRole
       FROM requests WHERE workspace_key = ?1 AND id = ?2
          AND (source_session_id = ?3 OR (
            target_session_id = ?4 AND (
              delivery_transport = 'native' OR EXISTS (
                SELECT 1 FROM context_admissions
                WHERE id = requests.id AND state = 'context_admitted'
              )
            )
          ))`,
    )
    .get(workspace, requestId, caller, caller);
  if (!row) return undefined;
  if (row.participantRole !== "source" && row.participantRole !== "target") {
    throw new StoreIntegrityError("Stored request participant authorization was invalid.");
  }
  return row.participantRole;
}

export function queryParticipantList(
  context: StoreContext,
  options: {
    readonly index: string;
    readonly participantColumn: "source_session_id" | "target_session_id";
    readonly predicate: string;
    readonly role: "source" | "target";
    readonly caller: string;
    readonly boundary: RequestListBoundary | undefined;
    readonly limit: number;
  },
): ParticipantRequestMetadata[] {
  const boundarySql = options.boundary ? "AND (created_at_ms, id) < (?3, ?4)" : "";
  const sql = `SELECT ${requestMetadataColumns}, '${options.role}' AS participantRole
    FROM requests INDEXED BY ${options.index}
    WHERE workspace_key = ?1 AND ${options.participantColumn} = ?2 AND ${options.predicate} ${boundarySql}
    ORDER BY created_at_ms DESC, id DESC LIMIT ?${options.boundary ? 5 : 3}`;
  const rows = options.boundary
    ? context.database
        .query<RoleRow, [string, string, number, string, number]>(sql)
        .all(
          context.workspaceKey,
          options.caller,
          options.boundary.createdAtMs,
          options.boundary.requestId,
          options.limit,
        )
    : context.database
        .query<RoleRow, [string, string, number]>(sql)
        .all(context.workspaceKey, options.caller, options.limit);
  return rows.map(hydrateParticipantRole);
}
