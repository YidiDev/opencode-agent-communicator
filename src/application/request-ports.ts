import type { NativeMessageId, RequestId, StartOperationId } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import type {
  AnsweredAskRequestMetadata,
  AskRequestPayload,
  AskRequestResult,
  PendingRequestMetadata,
  ReachedWaitRequestMetadata,
  RequestAcknowledgedResultMetadata,
  RequestAvailableResultMetadata,
  RequestExpiredResultMetadata,
  RequestMetadata,
  RequestResolutionState,
  RetainedRequestResult,
  WaitRequestPayload,
  WaitRequestResult,
} from "../domain/request-types";
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

export const requestStoreFailureCodes = [
  "deadlock_detected",
  "quota_exceeded",
  "rate_limited",
  "ownership_lost",
  "state_conflict",
  "storage_unavailable",
] as const;
export type RequestStoreFailureCode = (typeof requestStoreFailureCodes)[number];

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

export type RequestRetentionResult =
  | {
      readonly ok: true;
      readonly deletedRequests: number;
      readonly deletedRateEvents: number;
    }
  | { readonly ok: false; readonly code: RequestStoreFailureCode };

export interface RequestRetentionPersistencePort {
  /**
   * From one transaction-observed store time, deletes terminal metadata by resolved time and
   * independently prunes old rate events. Result expiry is deliberately excluded.
   */
  collectRequestRetention(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<RequestRetentionResult>;
}

export type RequestTerminalFailureCode = RequestStoreFailureCode | "not_found_or_unauthorized";
export type RequestTerminalFailure =
  | {
      readonly ok: false;
      readonly code: "state_conflict";
      /** Present only when an authorized, coherent authoritative state won. */
      readonly request?: RequestMetadata;
    }
  | {
      readonly ok: false;
      readonly code: Exclude<RequestTerminalFailureCode, "state_conflict">;
      readonly request?: never;
    };

export interface RequestParticipantMutationInput {
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly requestId: RequestId;
  readonly callerSessionId: SessionId;
}

export type RequestTerminalWriteResult<
  Metadata extends RequestMetadata,
  Result extends RetainedRequestResult,
> =
  | {
      readonly ok: true;
      readonly outcome: "applied";
      readonly request: Metadata;
      readonly result: Result;
    }
  | RequestTerminalFailure;

export type AuthoritativeTerminalResolution = Exclude<RequestResolutionState, "pending">;
export type RequestMetadataAtResolution<State extends RequestResolutionState> = Extract<
  RequestMetadata,
  { readonly resolutionState: State }
>;
type NonCancelledTerminalResolution = Exclude<AuthoritativeTerminalResolution, "cancelled">;
type CancelTerminalStateResult = {
  [State in NonCancelledTerminalResolution]: {
    readonly ok: true;
    readonly outcome: "terminal_state";
    readonly resolutionState: State;
    readonly request: RequestMetadataAtResolution<State>;
  };
}[NonCancelledTerminalResolution];
export type AnsweredOrReachedRequestMetadata =
  | AnsweredAskRequestMetadata
  | ReachedWaitRequestMetadata;
export type AcknowledgedAnsweredOrReachedRequestMetadata = AnsweredOrReachedRequestMetadata &
  RequestAcknowledgedResultMetadata;
export type ExpiredAnsweredOrReachedRequestMetadata = AnsweredOrReachedRequestMetadata &
  RequestExpiredResultMetadata;

export type CancelPendingResult =
  | {
      readonly ok: true;
      readonly outcome: "applied" | "idempotent";
      readonly resolutionState: "cancelled";
      readonly request: RequestMetadataAtResolution<"cancelled">;
    }
  | CancelTerminalStateResult
  | RequestTerminalFailure;

export type AcknowledgeRequestResult =
  | {
      readonly ok: true;
      readonly outcome: "applied" | "idempotent";
      readonly request: AcknowledgedAnsweredOrReachedRequestMetadata;
    }
  | RequestTerminalFailure;

export type ExpireAvailableResultsResult =
  | { readonly ok: true; readonly requests: readonly ExpiredAnsweredOrReachedRequestMetadata[] }
  | { readonly ok: false; readonly code: RequestStoreFailureCode };

export interface RequestTerminalPersistencePort {
  answerAsk(
    input: RequestParticipantMutationInput & { readonly answers: AskRequestResult["answers"] },
  ): Promise<RequestTerminalWriteResult<AnsweredAskRequestMetadata, AskRequestResult>>;
  signalWait(
    input: RequestParticipantMutationInput & { readonly evidence?: string },
  ): Promise<RequestTerminalWriteResult<ReachedWaitRequestMetadata, WaitRequestResult>>;
  cancelPending(input: RequestParticipantMutationInput): Promise<CancelPendingResult>;
  acknowledgeResult(input: RequestParticipantMutationInput): Promise<AcknowledgeRequestResult>;
}

export interface RequestResultRetentionPersistencePort {
  /** Store-clock transition of at most 100 available results at their exact 24-hour boundary. */
  expireAvailableResults(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<ExpireAvailableResultsResult>;
}

type SafeRequestMetadataKey =
  | "kind"
  | "resolutionState"
  | "deliveryState"
  | "resultState"
  | "sourceSessionId"
  | "targetSessionId"
  | "createdAtMs"
  | "updatedAtMs"
  | "deadlineAtMs"
  | "resolvedAtMs"
  | "submittedAtMs"
  | "deliveryUnknownAtMs"
  | "admittedAtMs"
  | "promotedAtMs"
  | "deliveryFailedAtMs"
  | "resultAvailableAtMs"
  | "resultExpiresAtMs"
  | "resultExpiredAtMs"
  | "acknowledgedAtMs";
type RedactedRequestMetadata<
  Metadata extends RequestMetadata,
  Role extends import("../domain/request-types").RequestParticipantRole,
> = Metadata extends RequestMetadata
  ? { readonly requestId: RequestId; readonly participantRole: Role } & Pick<
      Metadata,
      Extract<keyof Metadata, SafeRequestMetadataKey>
    >
  : never;

export type ParticipantRequestMetadata<
  Role extends
    import("../domain/request-types").RequestParticipantRole = import("../domain/request-types").RequestParticipantRole,
  Metadata extends RequestMetadata = RequestMetadata,
> = RedactedRequestMetadata<Metadata, Role>;

type PendingAskMetadata = PendingRequestMetadata & { readonly kind: "ask" };
type PendingWaitMetadata = PendingRequestMetadata & { readonly kind: "wait" };
type AvailableAnsweredAskMetadata = AnsweredAskRequestMetadata & RequestAvailableResultMetadata;
type UnavailableAnsweredAskMetadata = AnsweredAskRequestMetadata &
  (RequestExpiredResultMetadata | RequestAcknowledgedResultMetadata);
type AvailableReachedWaitMetadata = ReachedWaitRequestMetadata & RequestAvailableResultMetadata;
type UnavailableReachedWaitMetadata = ReachedWaitRequestMetadata &
  (RequestExpiredResultMetadata | RequestAcknowledgedResultMetadata);
type UnsuccessfulRequestMetadata = Exclude<
  RequestMetadata,
  PendingRequestMetadata | AnsweredAskRequestMetadata | ReachedWaitRequestMetadata
>;

export interface ParticipantRequestPage {
  readonly items: readonly ParticipantRequestMetadata[];
  readonly hasMore: boolean;
}

export interface ParticipantRequestRepositoryPage {
  readonly items: readonly ParticipantRequestMetadata[];
  readonly hasMore: boolean;
  readonly terminalized: readonly RequestMetadata[];
}

export type ParticipantRequestGet =
  | {
      readonly outcome: "metadata";
      readonly view: "source_pending";
      readonly metadata: ParticipantRequestMetadata<"source", PendingRequestMetadata>;
    }
  | {
      readonly outcome: "metadata";
      readonly view: "target_terminal";
      readonly metadata: ParticipantRequestMetadata<
        "target",
        Exclude<RequestMetadata, PendingRequestMetadata>
      >;
    }
  | {
      readonly outcome: "metadata";
      readonly view: "source_unsuccessful_terminal";
      readonly metadata: ParticipantRequestMetadata<"source", UnsuccessfulRequestMetadata>;
    }
  | {
      readonly outcome: "pending_payload";
      readonly metadata: ParticipantRequestMetadata<"target", PendingAskMetadata>;
      readonly payload: AskRequestPayload;
    }
  | {
      readonly outcome: "pending_payload";
      readonly metadata: ParticipantRequestMetadata<"target", PendingWaitMetadata>;
      readonly payload: WaitRequestPayload;
    }
  | {
      readonly outcome: "available_result";
      readonly metadata: ParticipantRequestMetadata<"source", AvailableAnsweredAskMetadata>;
      readonly result: AskRequestResult;
    }
  | {
      readonly outcome: "available_result";
      readonly metadata: ParticipantRequestMetadata<"source", AvailableReachedWaitMetadata>;
      readonly result: WaitRequestResult;
    }
  | {
      readonly outcome: "result_expired";
      readonly metadata:
        | ParticipantRequestMetadata<"source", UnavailableAnsweredAskMetadata>
        | ParticipantRequestMetadata<"source", UnavailableReachedWaitMetadata>;
    };

/** Internal repository result. The public projection and transition notifications are separated. */
export type ParticipantRequestRepositoryGet = ParticipantRequestGet & {
  readonly terminalized: readonly RequestMetadata[];
};

export interface RequestParticipantQueryPort {
  listForParticipant(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly callerSessionId: SessionId;
    readonly role: import("../domain/request-types").RequestListRole;
    readonly boundary?: import("./request-list-cursor").RequestListBoundary;
    readonly limit: number;
  }): Promise<ParticipantRequestRepositoryPage>;
  getParticipantRequest(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly requestId: RequestId;
    readonly callerSessionId: SessionId;
  }): Promise<ParticipantRequestRepositoryGet | undefined>;
}
