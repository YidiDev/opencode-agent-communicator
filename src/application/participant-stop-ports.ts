import type { FencingToken } from "../domain/ownership";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { SessionStopPersistencePort, StopPendingRequestsResult } from "./session-stop-ports";

export type ParticipantStopActivity = "busy" | "retry" | "idle" | "not_visible" | "unknown";

export interface ParticipantStopActivityObservation {
  readonly sessionId: SessionId;
  readonly activity: ParticipantStopActivity;
}

export type ParticipantStopCandidatesResult =
  | { readonly ok: true; readonly sessionIds: readonly SessionId[] }
  | { readonly ok: false; readonly code: "ownership_lost" | "storage_unavailable" };

export interface NativeParticipantStopActivityPort {
  observeParticipantActivities(
    workspaceKey: WorkspaceKey,
    participantSessionIds: readonly SessionId[],
    abort: AbortSignal,
  ): Promise<readonly ParticipantStopActivityObservation[]>;
}

export interface ParticipantStopPersistencePort extends SessionStopPersistencePort {
  stopPendingBlockingRequests(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly stoppedSessionId: SessionId;
  }): Promise<StopPendingRequestsResult>;
  listParticipantStopCandidates(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
  }): Promise<ParticipantStopCandidatesResult>;
}
