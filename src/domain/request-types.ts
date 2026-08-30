import type { NativeMessageId, RequestId, StartOperationId } from "./generated-ids";
import type { Sha256Digest } from "./message-payload";
import type { SessionId } from "./sessions";
import type { WorkspaceKey } from "./workspaces";

export const requestKinds = ["ask", "wait"] as const;
export type RequestKind = (typeof requestKinds)[number];

export const requestResolutionStates = [
  "pending",
  "answered",
  "reached",
  "deadline_expired",
  "cancelled",
  "delivery_failed",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
] as const;
export type RequestResolutionState = (typeof requestResolutionStates)[number];
export type UnsuccessfulRequestResolutionState = Exclude<
  RequestResolutionState,
  "pending" | "answered" | "reached"
>;

export const requestDeliveryStates = [
  "prepared",
  "submitting",
  "delivery_unknown",
  "admitted",
  "promoted",
  "delivery_failed",
] as const;
export type RequestDeliveryState = (typeof requestDeliveryStates)[number];

export const requestResultStates = ["none", "available", "expired", "acknowledged"] as const;
export type RequestResultState = (typeof requestResultStates)[number];
export type RequestParticipantRole = "source" | "target";
export type RequestListRole = "inbox" | "outbox" | "all";
export const requestDeliveryModes = ["steer", "queue", "initial"] as const;
export type RequestDeliveryMode = (typeof requestDeliveryModes)[number];

export interface AskQuestion {
  readonly prompt: string;
  readonly options: readonly string[];
  readonly multiple: boolean;
  readonly allowCustom: boolean;
}

export interface AskRequestPayload {
  readonly kind: "ask";
  readonly questions: readonly AskQuestion[];
  readonly timeoutSeconds: number;
}
export type AskPayload = AskRequestPayload;

export interface WaitRequestPayload {
  readonly kind: "wait";
  readonly milestone: string;
  readonly timeoutSeconds: number;
}
export type WaitPayload = WaitRequestPayload;
export type PendingRequestPayload = AskRequestPayload | WaitRequestPayload;

export type AskAnswers = readonly (readonly string[])[];
export interface AskRequestResult {
  readonly kind: "ask";
  readonly answers: AskAnswers;
}
export interface WaitEvidence {
  readonly evidence?: string;
}
export interface WaitRequestResult extends WaitEvidence {
  readonly kind: "wait";
}
export type RetainedRequestResult = AskRequestResult | WaitRequestResult;

interface AdmissionEvidenceBase {
  readonly nativeMessageId: NativeMessageId;
  readonly admittedSeq: number;
  readonly observedAtMs: number;
}
export type RequestAdmissionEvidence =
  | (AdmissionEvidenceBase & { readonly state: "admitted" })
  | (AdmissionEvidenceBase & { readonly state: "promoted"; readonly promotedSeq: number });

interface NoAdmissionFields {
  readonly admittedAtMs?: never;
  readonly promotedAtMs?: never;
  readonly admissionEvidence?: never;
}
export interface RequestPreparedDeliveryMetadata extends NoAdmissionFields {
  readonly deliveryState: "prepared";
  readonly submittedAtMs?: never;
  readonly deliveryUnknownAtMs?: never;
  readonly deliveryFailedAtMs?: never;
}
export interface RequestSubmittingDeliveryMetadata extends NoAdmissionFields {
  readonly deliveryState: "submitting";
  readonly submittedAtMs: number;
  readonly deliveryUnknownAtMs?: never;
  readonly deliveryFailedAtMs?: never;
}
export interface RequestUnknownDeliveryMetadata extends NoAdmissionFields {
  readonly deliveryState: "delivery_unknown";
  readonly submittedAtMs: number;
  readonly deliveryUnknownAtMs: number;
  readonly deliveryFailedAtMs?: never;
}
export interface RequestAdmittedDeliveryMetadata {
  readonly deliveryState: "admitted";
  readonly submittedAtMs: number;
  readonly deliveryUnknownAtMs?: never;
  readonly admittedAtMs: number;
  readonly promotedAtMs?: never;
  readonly deliveryFailedAtMs?: never;
  readonly admissionEvidence: Extract<RequestAdmissionEvidence, { readonly state: "admitted" }>;
}
export interface RequestPromotedDeliveryMetadata {
  readonly deliveryState: "promoted";
  readonly submittedAtMs: number;
  readonly deliveryUnknownAtMs?: never;
  readonly admittedAtMs: number;
  readonly promotedAtMs: number;
  readonly deliveryFailedAtMs?: never;
  readonly admissionEvidence: Extract<RequestAdmissionEvidence, { readonly state: "promoted" }>;
}
interface RequestFailedDeliveryMetadataBase extends NoAdmissionFields {
  readonly deliveryState: "delivery_failed";
  readonly submittedAtMs: number;
  readonly deliveryFailedAtMs: number;
}
export interface RequestFailedFromSubmittingDeliveryMetadata
  extends RequestFailedDeliveryMetadataBase {
  readonly deliveryUnknownAtMs?: never;
}
export interface RequestFailedFromUnknownDeliveryMetadata
  extends RequestFailedDeliveryMetadataBase {
  readonly deliveryUnknownAtMs: number;
}
export type RequestFailedDeliveryMetadata =
  | RequestFailedFromSubmittingDeliveryMetadata
  | RequestFailedFromUnknownDeliveryMetadata;
export type RequestDeliveryMetadata =
  | RequestPreparedDeliveryMetadata
  | RequestSubmittingDeliveryMetadata
  | RequestUnknownDeliveryMetadata
  | RequestAdmittedDeliveryMetadata
  | RequestPromotedDeliveryMetadata
  | RequestFailedDeliveryMetadata;
export type RequestNonFailedDeliveryMetadata = Exclude<
  RequestDeliveryMetadata,
  RequestFailedDeliveryMetadata
>;

export interface RequestNoResultMetadata {
  readonly resultState: "none";
  readonly resultByteLength?: never;
  readonly resultSha256?: never;
  readonly resultAvailableAtMs?: never;
  readonly resultExpiresAtMs?: never;
  readonly resultExpiredAtMs?: never;
  readonly acknowledgedAtMs?: never;
}
interface HistoricalResultMetadata {
  readonly resultByteLength?: never;
  readonly resultSha256?: never;
  readonly resultAvailableAtMs: number;
  readonly resultExpiresAtMs: number;
}
export interface RequestAvailableResultMetadata {
  readonly resultState: "available";
  readonly resultByteLength: number;
  readonly resultSha256: Sha256Digest;
  readonly resultAvailableAtMs: number;
  readonly resultExpiresAtMs: number;
  readonly resultExpiredAtMs?: never;
  readonly acknowledgedAtMs?: never;
}
export interface RequestExpiredResultMetadata extends HistoricalResultMetadata {
  readonly resultState: "expired";
  readonly resultExpiredAtMs: number;
  readonly acknowledgedAtMs?: never;
}
export interface RequestAcknowledgedResultMetadata extends HistoricalResultMetadata {
  readonly resultState: "acknowledged";
  readonly resultExpiredAtMs?: number;
  readonly acknowledgedAtMs: number;
}
export type RequestRetainedResultMetadata =
  | RequestAvailableResultMetadata
  | RequestExpiredResultMetadata
  | RequestAcknowledgedResultMetadata;

export interface RequestMetadataBase {
  readonly id: RequestId;
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly nativeMessageId: NativeMessageId;
  readonly deliveryMode?: RequestDeliveryMode;
  readonly linkedStartOperationId?: StartOperationId;
  readonly payloadByteLength: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deadlineAtMs: number;
}

interface PendingPayloadIdentityMetadata {
  readonly payloadSha256: Sha256Digest;
}
interface ErasedPayloadIdentityMetadata {
  readonly payloadSha256?: never;
}

export type PendingRequestMetadata = RequestMetadataBase &
  PendingPayloadIdentityMetadata &
  RequestNonFailedDeliveryMetadata &
  RequestNoResultMetadata & {
    readonly kind: RequestKind;
    readonly resolutionState: "pending";
    readonly resolvedAtMs?: never;
  };
export type AnsweredAskRequestMetadata = RequestMetadataBase &
  ErasedPayloadIdentityMetadata &
  RequestDeliveryMetadata &
  RequestRetainedResultMetadata & {
    readonly kind: "ask";
    readonly resolutionState: "answered";
    readonly resolvedAtMs: number;
  };
export type ReachedWaitRequestMetadata = RequestMetadataBase &
  ErasedPayloadIdentityMetadata &
  RequestDeliveryMetadata &
  RequestRetainedResultMetadata & {
    readonly kind: "wait";
    readonly resolutionState: "reached";
    readonly resolvedAtMs: number;
  };
export type FailedDeliveryRequestMetadata = RequestMetadataBase &
  ErasedPayloadIdentityMetadata &
  RequestFailedDeliveryMetadata &
  RequestNoResultMetadata & {
    readonly kind: RequestKind;
    readonly resolutionState: "delivery_failed";
    readonly resolvedAtMs: number;
  };
type OtherUnsuccessfulResolutionState = Exclude<
  UnsuccessfulRequestResolutionState,
  "delivery_failed"
>;
export type OtherUnsuccessfulRequestMetadata = {
  [State in OtherUnsuccessfulResolutionState]: RequestMetadataBase &
    ErasedPayloadIdentityMetadata &
    RequestDeliveryMetadata &
    RequestNoResultMetadata & {
      readonly kind: RequestKind;
      readonly resolutionState: State;
      readonly resolvedAtMs: number;
    };
}[OtherUnsuccessfulResolutionState];
export type UnsuccessfulTerminalRequestMetadata =
  | FailedDeliveryRequestMetadata
  | OtherUnsuccessfulRequestMetadata;
export type RequestMetadata =
  | PendingRequestMetadata
  | AnsweredAskRequestMetadata
  | ReachedWaitRequestMetadata
  | UnsuccessfulTerminalRequestMetadata;
