import type {
  DeliveryMetadata,
  DeliveryParticipantRole,
  DeliveryState,
} from "../domain/deliveries";
import type { DeliveryId, NativeMessageId } from "../domain/generated-ids";
import type { Sha256Digest } from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";

export interface CurrentRootMembership {
  readonly sourceTitle: string | undefined;
  readonly sourceVisible: boolean;
  readonly targetVisible: boolean;
}

export interface CurrentWorkspaceMembershipPort {
  readCurrentRoots(
    workspaceKey: WorkspaceKey,
    sourceSessionId: SessionId,
    targetSessionId: SessionId,
  ): Promise<CurrentRootMembership>;
}

export interface ClockPort {
  nowMs(): number;
}

export interface OwnershipPort {
  /** Acquires one opaque epoch newer than every token previously granted by this owner store. */
  acquire(): Promise<FencingToken>;
  isCurrent(token: FencingToken): Promise<boolean>;
}

export interface OperationControl {
  readonly abort: AbortSignal;
  readonly deadlineMs?: number;
}

export type MessageAuthorizationDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny" }
  | { readonly kind: "approval_rejected" };

export interface MessageAuthorizationPort {
  authorizeMessage(
    binding: {
      readonly workspaceKey: WorkspaceKey;
      readonly sourceSessionId: SessionId;
      readonly targetSessionId: SessionId;
      readonly operation: "message";
      readonly contentSha256: Sha256Digest;
      readonly contentByteLength: number;
    },
    control: OperationControl,
  ): Promise<MessageAuthorizationDecision>;
}

export type DeliveryStoreFailureCode =
  | "quota_exceeded"
  | "rate_limited"
  | "ownership_lost"
  | "state_conflict"
  | "storage_unavailable";

export type DeliveryStoreResult =
  | { readonly ok: true; readonly delivery: DeliveryMetadata }
  | { readonly ok: false; readonly code: DeliveryStoreFailureCode };

export interface PrepareDeliveryInput {
  readonly fencingToken: FencingToken;
  readonly id: DeliveryId;
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly nativeMessageId: NativeMessageId;
  /** Complete verified envelope; this is the only durable prepared payload. */
  readonly envelope: string;
  readonly contentByteLength: number;
  readonly contentSha256: Sha256Digest;
  readonly nowMs: number;
}

export interface DeliveryTransitionInput {
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly deliveryId: DeliveryId;
  readonly nowMs: number;
}

export type CompleteSubmissionInput = DeliveryTransitionInput &
  (
    | { readonly state: "failed" | "admission_unknown" }
    | {
        readonly state: "admitted";
        readonly admittedSeq: number;
        readonly evidenceObservedAtMs: number;
      }
    | {
        readonly state: "promoted";
        readonly admittedSeq: number;
        readonly promotedSeq: number;
        readonly evidenceObservedAtMs: number;
      }
  );

export type DeliveryClaimResult =
  | {
      readonly ok: true;
      readonly delivery: DeliveryMetadata & { readonly state: "submitting" };
      /** Process-local return from the transaction that durably erased this value. */
      readonly envelope: string;
    }
  | { readonly ok: true; readonly delivery: DeliveryMetadata; readonly envelope?: undefined }
  | { readonly ok: false; readonly code: DeliveryStoreFailureCode };

export interface DeliveryPersistencePort {
  /** Atomically applies source, target, workspace, byte, rate, and record quotas. */
  createPrepared(input: PrepareDeliveryInput): Promise<DeliveryStoreResult>;
  /** Cancels only prepared records. All transitions are compare-and-set and fenced. */
  cancelPrepared(input: DeliveryTransitionInput): Promise<DeliveryStoreResult>;
  /** Atomically claims prepared, returns its envelope, and durably erases the envelope. */
  claimPrepared(input: DeliveryTransitionInput): Promise<DeliveryClaimResult>;
  /**
   * Applies only legal domain transitions and stamps from nowMs. Promoted atomically records the
   * logical admitted then promoted history with both strictly ordered sequence values.
   */
  completeSubmission(input: CompleteSubmissionInput): Promise<DeliveryStoreResult>;
  listRecoverable(
    input:
      | {
          readonly fencingToken: FencingToken;
          readonly workspaceKey: WorkspaceKey;
          readonly state: "prepared";
          readonly limit: number;
        }
      | {
          readonly fencingToken: FencingToken;
          readonly workspaceKey: WorkspaceKey;
          readonly state: "submitting";
          readonly limit: number;
          readonly excludeClaimedByToken: FencingToken;
          readonly startupBarrier: StartupRecoveryBarrier;
        },
  ): Promise<readonly DeliveryMetadata[]>;
  getForParticipant(input: {
    readonly workspaceKey: WorkspaceKey;
    readonly deliveryId: DeliveryId;
    readonly participantSessionId: SessionId;
  }): Promise<
    { readonly role: DeliveryParticipantRole; readonly delivery: DeliveryMetadata } | undefined
  >;
}

export type NativeQueueAdmission =
  | { readonly kind: "admitted"; readonly admittedSeq: number; readonly observedAtMs: number }
  | {
      readonly kind: "promoted";
      readonly admittedSeq: number;
      readonly promotedSeq: number;
      readonly observedAtMs: number;
    }
  | { readonly kind: "definitive_rejection" }
  | { readonly kind: "unknown" };

export interface NativeQueueAdmissionPort {
  /** Caller-aborted transport must throw or return unknown, never definitive_rejection. */
  queueMessage(input: {
    readonly targetSessionId: SessionId;
    readonly nativeMessageId: NativeMessageId;
    readonly envelope: string;
    readonly abort: AbortSignal;
  }): Promise<NativeQueueAdmission>;
}

export interface StartupRecoveryBarrier {
  readonly established: true;
  readonly fencingToken: FencingToken;
}

export interface RecoveryStartupBarrierPort {
  establish(token: FencingToken, control: OperationControl): Promise<StartupRecoveryBarrier>;
}

export function isSubmissionTerminalState(
  state: DeliveryState,
): state is "admitted" | "promoted" | "failed" | "admission_unknown" {
  return ["admitted", "promoted", "failed", "admission_unknown"].includes(state);
}
