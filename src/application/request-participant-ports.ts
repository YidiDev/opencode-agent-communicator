import type { RequestId } from "../domain/generated-ids";
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
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { RequestStoreFailureCode } from "./request-store-failures";

export type RequestRetentionResult =
  | { readonly ok: true; readonly deletedRequests: number; readonly deletedRateEvents: number }
  | { readonly ok: false; readonly code: RequestStoreFailureCode };

export interface RequestRetentionPersistencePort {
  collectRequestRetention(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<RequestRetentionResult>;
}

export type RequestTerminalFailureCode = RequestStoreFailureCode | "not_found_or_unauthorized";
export type RequestTerminalFailure =
  | { readonly ok: false; readonly code: "state_conflict"; readonly request?: RequestMetadata }
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
  | "deliveryMode"
  | "linkedStartOperationId"
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
export interface ParticipantRequestRepositoryPage extends ParticipantRequestPage {
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
