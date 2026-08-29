import type { FencingToken } from "../domain/ownership";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { ParticipantDeletionCandidatesResult } from "./participant-deletion-ports";
import type { SessionStopPersistencePort, StopPendingRequestsResult } from "./session-stop-ports";

export type ParticipantStopActivity = "busy" | "retry" | "idle" | "not_visible" | "unknown";

export interface NativeParticipantStopActivityPort {
  observeParticipantActivity(
    workspaceKey: WorkspaceKey,
    participantSessionId: SessionId,
    abort: AbortSignal,
  ): Promise<ParticipantStopActivity>;
}

export interface ParticipantStopPersistencePort extends SessionStopPersistencePort {
  stopPendingBlockingRequests(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly stoppedSessionId: SessionId;
  }): Promise<StopPendingRequestsResult>;
  listParticipantDeletionCandidates(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
  }): Promise<ParticipantDeletionCandidatesResult>;
}
