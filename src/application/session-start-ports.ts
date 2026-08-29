import type { NativeMessageId, StartOperationId } from "../domain/generated-ids";
import type { Sha256Digest } from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import type {
  StartAdmissionState,
  StartCreationState,
  StartOperation,
  StartTitleState,
  ValidatedStartArguments,
} from "../domain/session-start";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { OperationControl } from "./delivery-ports";
import type { PrepareRequestInput, RequestStoreFailureCode } from "./request-ports";

export interface StartLimits {
  readonly managedSessionsPerWorkspace: number;
  readonly unresolvedProvenancePerWorkspace: number;
  readonly operationsPerWorkspace: number;
  readonly payloadBytesPerWorkspace: number;
  readonly startsPerSourceWindow: number;
  readonly startsPerWorkspaceWindow: number;
  readonly rateWindowMs: number;
  readonly terminalRetentionMs: number;
}

export type StartStoreFailureCode =
  | "idempotency_conflict"
  | "quota_exceeded"
  | "unresolved_provenance_quota_exceeded"
  | "rate_limited"
  | "state_conflict"
  | "ownership_lost"
  | "storage_unavailable";
export type StartStoreResult =
  | { readonly ok: true; readonly operation: StartOperation }
  | { readonly ok: false; readonly code: StartStoreFailureCode };

export interface PrepareStartOperationInput {
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly operationId: StartOperationId;
  readonly sessionId: SessionId;
  readonly nativeMessageId: NativeMessageId;
  readonly argumentsSha256: Sha256Digest;
  /** Optional source-scoped idempotency digest when private effect arguments contain generated IDs. */
  readonly idempotencyArgumentsSha256?: Sha256Digest;
  readonly arguments: ValidatedStartArguments;
  readonly limits: StartLimits;
  readonly nowMs: number;
}

export interface PrepareSessionRequestStartInput {
  readonly start: PrepareStartOperationInput;
  readonly request: PrepareRequestInput;
}

export type SessionRequestStartStoreResult =
  | {
      readonly ok: true;
      readonly operation: StartOperation;
      readonly request: import("../domain/request-types").RequestMetadata;
      readonly idempotencyArgumentsSha256: Sha256Digest;
    }
  | {
      readonly ok: false;
      readonly code: StartStoreFailureCode | RequestStoreFailureCode;
    };

export type SessionRequestStartLookupResult =
  | { readonly ok: true; readonly found: false }
  | {
      readonly ok: true;
      readonly found: true;
      readonly operation: StartOperation;
      readonly request: import("../domain/request-types").RequestMetadata;
    }
  | { readonly ok: false; readonly code: "idempotency_conflict" | "state_conflict" };

/** Persists a managed start and its initial durable request in one fenced transaction. */
export interface SessionRequestStartPersistencePort {
  readonly readSessionRequestStartByOperation?: (input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly operationId: StartOperationId;
  }) => Promise<
    | {
        readonly operation: StartOperation;
        readonly request: import("../domain/request-types").RequestMetadata;
      }
    | undefined
  >;
  readSessionRequestStart(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly sourceSessionId: SessionId;
    readonly idempotencyKey: string;
    readonly idempotencyArgumentsSha256: Sha256Digest;
  }): Promise<SessionRequestStartLookupResult>;
  createOrResumeSessionRequestStart(
    input: PrepareSessionRequestStartInput,
  ): Promise<SessionRequestStartStoreResult>;
}

export type StartStep = "creation" | "title" | "admission";
export interface StartTransitionInput {
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly operationId: StartOperationId;
  readonly nowMs: number;
}
export type PreparedStartRejection = "policy_denied" | "approval_rejected";
export type StartRetentionResult =
  | {
      readonly ok: true;
      readonly deletedOperations: number;
      readonly deletedRateEvents: number;
    }
  | { readonly ok: false; readonly code: StartStoreFailureCode };
export interface StartRecoveryQueryInput {
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly limit: number;
  readonly excludeClaimedByToken: FencingToken;
}
export type ClaimedStartStep =
  | {
      readonly ok: true;
      readonly operation: StartOperation;
      readonly arguments: ValidatedStartArguments;
    }
  | { readonly ok: false; readonly code: StartStoreFailureCode };

export interface StartOperationPersistencePort {
  createOrResume(input: PrepareStartOperationInput): Promise<StartStoreResult>;
  isManagedSession(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly sessionId: SessionId;
  }): Promise<boolean>;
  claimStep(input: StartTransitionInput & { readonly step: StartStep }): Promise<ClaimedStartStep>;
  /** Restores a claim only when the native call provably did not begin. */
  restorePreparedClaim(
    input: StartTransitionInput & { readonly step: StartStep },
  ): Promise<StartStoreResult>;
  releasePreparedReservation(input: StartTransitionInput): Promise<StartStoreResult>;
  rejectPreparedStart(
    input: StartTransitionInput & { readonly state: PreparedStartRejection },
  ): Promise<StartStoreResult>;
  classifyStaleSubmitting(
    input: StartTransitionInput & { readonly step: StartStep },
  ): Promise<StartStoreResult>;
  reconcileUnknownCreation(
    input: StartTransitionInput & {
      readonly outcome: "matching" | "absent" | "collision";
    },
  ): Promise<StartStoreResult>;
  completeCreation(
    input: StartTransitionInput & {
      readonly state: Exclude<StartCreationState, "prepared" | "submitting">;
    },
  ): Promise<StartStoreResult>;
  completeTitle(
    input: StartTransitionInput & {
      readonly state: Exclude<StartTitleState, "not_started" | "prepared" | "submitting">;
    },
  ): Promise<StartStoreResult>;
  completeAdmission(
    input: StartTransitionInput & {
      readonly state: Exclude<StartAdmissionState, "not_started" | "prepared" | "submitting">;
    },
  ): Promise<StartStoreResult>;
  listRecoverable(input: StartRecoveryQueryInput): Promise<readonly StartOperation[]>;
  collectRetention(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly nowMs: number;
    readonly terminalRetentionMs: number;
    readonly rateRetentionMs: number;
    readonly limit: number;
  }): Promise<StartRetentionResult>;
}

export type NativeStartCreation = "created" | "collision" | "definitive_rejection" | "unknown";
export type NativeStartReconciliation = "matching" | "absent" | "collision" | "unknown";
export type NativeTitleUpdate = "updated" | "definitive_rejection" | "unknown";
export type NativeInitialMessageAdmission = "admitted" | "definitive_rejection" | "unknown";
export interface NativeSessionStartPort {
  createRootSession(input: {
    readonly sessionId: SessionId;
    readonly agent?: string;
    readonly model?: string;
    readonly abort: AbortSignal;
  }): Promise<NativeStartCreation>;
  reconcileRootSession(input: {
    readonly sessionId: SessionId;
    readonly agent?: string;
    readonly model?: string;
    readonly abort: AbortSignal;
  }): Promise<NativeStartReconciliation>;
  updateSessionTitle(input: {
    readonly sessionId: SessionId;
    readonly title: string;
    readonly abort: AbortSignal;
  }): Promise<NativeTitleUpdate>;
  admitInitialMessage(input: {
    readonly sessionId: SessionId;
    readonly nativeMessageId: NativeMessageId;
    readonly message: string;
    readonly agent?: string;
    readonly model?: string;
    readonly abort: AbortSignal;
  }): Promise<NativeInitialMessageAdmission>;
}

export interface SessionStartApprovalPort {
  requestStartApproval(
    binding: {
      readonly workspaceKey: WorkspaceKey;
      readonly sourceSessionId: SessionId;
      readonly argumentsSha256: Sha256Digest;
    },
    control: OperationControl,
  ): Promise<"approved" | "rejected">;
}
