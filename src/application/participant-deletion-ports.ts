import type { FencingToken } from "../domain/ownership";
import type { RequestMetadata } from "../domain/request-types";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";

export type DeleteParticipantRequestsResult =
  | {
      readonly ok: true;
      /** Complete bounded metadata copied out only after the fenced transaction committed. */
      readonly terminalized: readonly RequestMetadata[];
    }
  | { readonly ok: false; readonly code: "ownership_lost" | "storage_unavailable" };

export type ParticipantPresence = "present" | "absent" | "unknown";

export interface NativeParticipantPresencePort {
  /** A direct pinned V2 read; only an exact session-correlated 404 may return absent. */
  readParticipantPresence(sessionId: SessionId, abort: AbortSignal): Promise<ParticipantPresence>;
}

/** @deprecated Prefer the security-explicit native port name. */
export type ParticipantPresencePort = NativeParticipantPresencePort;

export type ParticipantDeletionCandidatesResult =
  | { readonly ok: true; readonly sessionIds: readonly SessionId[] }
  | { readonly ok: false; readonly code: "ownership_lost" | "storage_unavailable" };

export interface DeleteAbsentParticipantRequestsInput {
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly absentSessionIds: readonly SessionId[];
}

export interface ParticipantDeletionPersistencePort {
  listParticipantDeletionCandidates(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
  }): Promise<ParticipantDeletionCandidatesResult>;

  deleteParticipantRequests(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly deletedSessionId: SessionId;
  }): Promise<DeleteParticipantRequestsResult>;

  /** Atomically applies one complete, bounded anti-entropy absence classification. */
  deleteAbsentParticipantRequests(
    input: DeleteAbsentParticipantRequestsInput,
  ): Promise<DeleteParticipantRequestsResult>;
}
