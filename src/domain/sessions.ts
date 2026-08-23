export type SessionId = string & { readonly sessionId: unique symbol };

export const sessionIdPolicy = {
  prefix: "ses_",
  normalGeneratedPayloadLength: 26,
  maximumHostPayloadLength: 124,
  payloadCharacters: "ASCII alphanumeric",
} as const;

export type ActivityStatus = "busy" | "retry" | "idle" | "unknown";
export type SessionStatusFilter = "active" | "idle" | "all";

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
