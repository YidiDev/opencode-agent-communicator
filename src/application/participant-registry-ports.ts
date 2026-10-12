import type { FencingToken } from "../domain/ownership";
import type {
  ActivityStatus,
  ParticipantRegistryRecord,
  ParticipantRootKind,
  ParticipantVisibility,
  SessionId,
} from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";

export interface ParticipantObservation {
  readonly sessionId: SessionId;
  readonly rootKind: ParticipantRootKind;
  readonly parentSessionId: SessionId | null;
  /** Must already be display-sanitized. Omission preserves previously observed metadata. */
  readonly title?: string;
  readonly isArchived?: boolean;
  /** `unknown` deliberately carries no authoritative activity timestamp. */
  readonly activityStatus?: ActivityStatus;
  readonly visibility?: Exclude<ParticipantVisibility, "unknown">;
}

export type ParticipantRegistryMutationResult =
  | { readonly ok: true; readonly recorded: number }
  | {
      readonly ok: false;
      readonly code: "state_conflict" | "quota_exceeded" | "storage_unavailable" | "ownership_lost";
    };

export interface ParticipantRegistryPersistencePort {
  recordParticipantObservations(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly observedAtMs: number;
    readonly observations: readonly ParticipantObservation[];
  }): Promise<ParticipantRegistryMutationResult>;

  listParticipantRootCandidates(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<readonly ParticipantRegistryRecord[]>;

  getParticipantRootCandidate(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly sessionId: SessionId;
  }): Promise<ParticipantRegistryRecord | undefined>;
}

/** Composition binds fencing and uses these candidates only to drive authoritative host reads. */
export interface ParticipantRegistryListingPort {
  listRootCandidates(
    workspaceKey: WorkspaceKey,
    limit: number,
  ): Promise<readonly ParticipantRegistryRecord[]>;
}

/** An absent or non-root host result must remain absent; registry evidence cannot promote it. */
export interface ParticipantRootRevalidationPort {
  revalidateRoot(
    workspaceKey: WorkspaceKey,
    sessionId: SessionId,
    abort?: AbortSignal,
  ): Promise<import("../domain/sessions").RootSessionObservation | undefined>;
}
