import type { NativeMessageId, RequestId, StartOperationId } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import type { PendingRequestMetadata, RequestMetadata } from "../domain/request-types";
import type { ActivityStatus, SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type {
  ClockPort,
  OperationControl,
  OwnershipPort,
  StartupRecoveryBarrier,
} from "./delivery-ports";
import type { CommittedRequestNotificationPort } from "./request-notification-port";

export type {
  RequestAuthorizationDecision,
  RequestAuthorizationPort,
} from "./request-authorization-port";
export * from "./request-participant-ports";
export {
  type RequestStoreFailureCode,
  requestStoreFailureCodes,
} from "./request-store-failures";

import type { RequestStoreFailureCode } from "./request-store-failures";

export type RequestStoreResult =
  | { readonly ok: true; readonly request: RequestMetadata }
  | { readonly ok: false; readonly code: RequestStoreFailureCode };

export type NativeSteerAdmission =
  | { readonly kind: "admitted"; readonly admittedSeq: number; readonly observedAtMs: number }
  | {
      readonly kind: "promoted";
      readonly admittedSeq: number;
      readonly promotedSeq: number;
      readonly observedAtMs: number;
    }
  | { readonly kind: "definitive_rejection" }
  | { readonly kind: "unknown" };

export interface NativeSteerAdmissionPort {
  steerRequest(input: {
    readonly targetSessionId: SessionId;
    readonly nativeMessageId: NativeMessageId;
    readonly envelope: string;
    readonly abort: AbortSignal;
  }): Promise<NativeSteerAdmission>;
}

/** Minimal live observation needed to decide whether recovery may perform a request's first steer. */
export interface RequestParticipantActivityObservation {
  readonly sourceVisible: boolean;
  readonly targetVisible: boolean;
  readonly targetStatus: ActivityStatus;
}

export interface RequestParticipantActivityPort {
  observeRequestParticipants(
    workspaceKey: WorkspaceKey,
    sourceSessionId: SessionId,
    targetSessionId: SessionId,
    abort: AbortSignal,
  ): Promise<RequestParticipantActivityObservation>;
}

export interface SessionRequestRecoveryPorts {
  readonly requests: RequestRecoveryPersistencePort &
    RequestAdmissionPersistencePort &
    RequestDeadlineSchedulePort;
  readonly activity: RequestParticipantActivityPort;
  readonly nativeSteer: NativeSteerAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly clock: ClockPort;
}

export interface SessionRequestRecoveryPhaseInput extends OperationControl {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: FencingToken;
  readonly startupBarrier: StartupRecoveryBarrier;
  readonly limit: number;
  readonly effectSignal: AbortSignal;
}

export interface PreparedSessionRequestRecoverySummary {
  readonly observed: number;
  readonly submitted: number;
  readonly skipped: number;
  readonly terminalizedAtClaim: number;
}

export interface PrepareRequestInput {
  readonly fencingToken: FencingToken;
  readonly creationOperationId: StartOperationId;
  readonly request: PendingRequestMetadata & { readonly deliveryState: "prepared" };
  readonly payloadJson: string;
  readonly envelopeJson: string;
}

export interface RequestTransitionInput {
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly requestId: RequestId;
}

export type CompleteRequestDeliveryInput = RequestTransitionInput &
  (
    | { readonly outcome: "delivery_unknown" }
    | { readonly outcome: "delivery_failed" }
    | {
        readonly outcome: "admitted";
        readonly nativeMessageId: NativeMessageId;
        readonly admittedSeq: number;
        readonly evidenceObservedAtMs: number;
      }
    | {
        readonly outcome: "promoted";
        readonly nativeMessageId: NativeMessageId;
        readonly admittedSeq: number;
        readonly promotedSeq: number;
        readonly evidenceObservedAtMs: number;
      }
  );

export type RequestClaimResult =
  | {
      readonly ok: true;
      readonly request: RequestMetadata & { readonly deliveryState: "submitting" };
      /** Process-local copy; the identical envelope remains in the durable inbox. */
      readonly envelopeJson: string;
    }
  | { readonly ok: true; readonly request: RequestMetadata; readonly envelopeJson?: undefined }
  | { readonly ok: false; readonly code: RequestStoreFailureCode };

export type ExpireDueRequestsResult =
  | { readonly ok: true; readonly requests: readonly RequestMetadata[] }
  | { readonly ok: false; readonly code: RequestStoreFailureCode };

/** One fenced store-clock observation used to schedule pending request deadlines. */
export type NextPendingRequestDeadline = Readonly<{
  readonly storeObservedAtMs: number;
  /** Exact positive store-provided lease renewal/recheck ceiling. */
  readonly maximumSleepMs: number;
  readonly nextDeadlineAtMs?: number;
}>;

export interface RequestDeadlineSchedulePort {
  /**
   * Reads the earliest pending deadline and store time under the same workspace/token fence.
   * Caller time is deliberately absent: persistence time remains authoritative.
   */
  readNextPendingDeadline(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
  }): Promise<NextPendingRequestDeadline>;
}

export interface RequestDeadlinePersistencePort extends RequestDeadlineSchedulePort {
  expireDueRequests(
    input: Parameters<RequestAdmissionPersistencePort["expireDueRequests"]>[0],
  ): Promise<ExpireDueRequestsResult>;
}

export interface RequestAdmissionPersistencePort {
  /**
   * In one serialized transaction: fences ordinary work; validates metadata, canonical payload,
   * verified envelope, exact payload-derived deadline and byte identity; handles exact pending
   * replay before quotas; enforces all count/byte/rate/deadlock limits using a store-clock rate
   * timestamp; and inserts metadata, payload, wait edge and rate event. No subset may be visible.
   */
  createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  reconcilePreparedCreation(input: PrepareRequestInput): Promise<RequestCreationReconciliation>;
  /**
   * Revalidates the private payload/envelope trust boundary, then fenced-CASes prepared+pending to
   * submitting using transaction-observed store time. At/after deadline it atomically terminalizes
   * instead. Only a winning predeadline transaction returns native-submission eligibility.
   */
  claimPrepared(input: RequestTransitionInput): Promise<RequestClaimResult>;
  reconcilePreparedClaim(input: RequestTransitionInput): Promise<RequestClaimReconciliation>;
  /**
   * Fenced legal delivery CAS whose persisted transition/deadline time is transaction-observed
   * store time. Native evidence remains historical but cannot exceed that time.
   */
  completeDelivery(input: CompleteRequestDeliveryInput): Promise<RequestStoreResult>;
  /**
   * At transaction-observed store time, terminalizes at most limit due pending requests, erases
   * retained payload/edge/digest bytes, and returns metadata for process-local notification.
   */
  expireDueRequests(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<ExpireDueRequestsResult>;
}

export type RequestCreationReconciliation =
  | { readonly outcome: "absent" }
  | { readonly outcome: "matching"; readonly request: RequestMetadata }
  | { readonly outcome: "conflict" };

export type RequestClaimReconciliation =
  | {
      readonly outcome: "still_prepared";
      readonly request: PendingRequestMetadata & { readonly deliveryState: "prepared" };
    }
  | { readonly outcome: "absent_or_other_claim" }
  | {
      readonly outcome: "current_claim";
      readonly request: RequestMetadata & { readonly deliveryState: "submitting" };
      readonly envelopeJson: string;
    }
  | { readonly outcome: "settled"; readonly request: RequestMetadata };

export interface RequestRecoveryPersistencePort {
  /** Prepared scans use fenced store time; submitting scans require the unforgeable startup barrier. */
  listRecoverableRequests(
    input:
      | {
          readonly fencingToken: FencingToken;
          readonly workspaceKey: WorkspaceKey;
          readonly state: "prepared";
          readonly limit: number;
          /** Immutable exclusive keyset boundary. Absence starts at the first prepared request. */
          readonly cursor?: Readonly<{ readonly createdAtMs: number; readonly id: RequestId }>;
        }
      | {
          readonly fencingToken: FencingToken;
          readonly workspaceKey: WorkspaceKey;
          readonly state: "submitting";
          readonly limit: number;
          readonly excludeClaimedByToken: FencingToken;
          /** Must equal fencingToken; a barrier cannot enumerate current-generation claims. */
          readonly startupBarrier: StartupRecoveryBarrier;
        },
  ): Promise<readonly RequestMetadata[]>;
  /** Establishes the same barrier used by message recovery; control cancellation is fail-closed. */
  establish(token: FencingToken, control: OperationControl): Promise<StartupRecoveryBarrier>;
}
