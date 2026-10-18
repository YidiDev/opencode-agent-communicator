export type SessionId = string & { readonly sessionId: unique symbol };

export const sessionIdPolicy = {
  prefix: "ses_",
  normalGeneratedPayloadLength: 26,
  maximumHostPayloadLength: 124,
  payloadCharacters: "ASCII alphanumeric",
} as const;

export type ActivityStatus = "busy" | "retry" | "idle" | "unknown";
export type SessionStatusFilter = "active" | "idle" | "all";

export const participantRegistryPolicy = {
  maximumRowsPerWorkspace: 262_144,
  maximumObservationBatch: 100,
  maximumListLimit: 100,
  maximumTitleUtf8Bytes: 512,
} as const;

export type ParticipantRootKind = "root" | "child";
export type ParticipantVisibility = "visible" | "not_visible" | "unknown";

/**
 * Bounded host evidence retained by the communicator. Activity and visibility are observations,
 * not authorization: callers must still revalidate a candidate against the current host state.
 */
export interface ParticipantRegistryRecord {
  readonly id: SessionId;
  readonly rootKind: ParticipantRootKind;
  readonly parentSessionId: SessionId | null;
  readonly title: string | null;
  readonly isArchived: boolean | null;
  readonly activityStatus: ActivityStatus;
  readonly activityObservedAtMs: number | null;
  readonly visibility: ParticipantVisibility;
  readonly visibilityObservedAtMs: number | null;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
}

export interface RootSessionObservation {
  readonly id: SessionId;
  readonly title: string;
  readonly updatedAtMs: number;
  readonly isArchived: boolean;
  readonly status: ActivityStatus;
  readonly observedAtMs: number;
}

export interface VisibleRootSessionPort {
  readVisibleRoots(includeArchived: boolean): Promise<readonly RootSessionObservation[]>;
}

export type SessionIdValidation =
  | { readonly ok: true; readonly value: SessionId }
  | { readonly ok: false; readonly message: string };

export function validateSessionId(value: unknown): SessionIdValidation {
  // Visible IDs are canonical host identifiers and may be caller-supplied by the host. Validation
  // establishes a bounded, transport-safe namespace; it cannot establish generation or entropy.
  if (
    typeof value !== "string" ||
    value.length > sessionIdPolicy.prefix.length + sessionIdPolicy.maximumHostPayloadLength ||
    !/^ses_[A-Za-z0-9]+$/.test(value)
  ) {
    return { ok: false, message: "Session ID is malformed." };
  }
  return { ok: true, value: value as SessionId };
}
