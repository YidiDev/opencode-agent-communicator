import type { NativeMessageId, RequestId } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import type { PendingRequestMetadata, RequestMetadata } from "../domain/request-types";
import type { WorkspaceKey } from "../domain/workspaces";
import type { OperationControl, StartupRecoveryBarrier } from "./delivery-ports";

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

export interface PrepareRequestInput {
  readonly fencingToken: FencingToken;
  /** Must be coherent pending/prepared metadata for exactly the configured workspace. */
  readonly request: PendingRequestMetadata & { readonly deliveryState: "prepared" };
  /** Exact canonical JSON whose UTF-8 bytes and digest are bound by request metadata. */
  readonly payloadJson: string;
  /** Complete, communicator-verified JSON envelope. It remains durable while pending. */
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

export interface RequestAdmissionPersistencePort {
  /**
   * In one serialized transaction: fences ordinary work; validates metadata, canonical payload,
   * verified envelope, exact payload-derived deadline and byte identity; handles exact pending
   * replay before quotas; enforces all count/byte/rate/deadlock limits using a store-clock rate
   * timestamp; and inserts metadata, payload, wait edge and rate event. No subset may be visible.
   */
  createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  /**
   * Revalidates the private payload/envelope trust boundary, then fenced-CASes prepared+pending to
   * submitting using transaction-observed store time. At/after deadline it atomically terminalizes
   * instead. Only a winning predeadline transaction returns native-submission eligibility.
   */
  claimPrepared(input: RequestTransitionInput): Promise<RequestClaimResult>;
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

export interface RequestRecoveryPersistencePort {
  /** Prepared scans use fenced store time; submitting scans require the unforgeable startup barrier. */
  listRecoverableRequests(
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
