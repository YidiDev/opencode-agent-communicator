import type {
  ContextAdmissionId,
  ContextAdmissionKind,
  ContextAdmissionMetadata,
} from "../domain/context-admissions";
import type { DeliveryId, RequestId } from "../domain/generated-ids";
import type { Sha256Digest } from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { RequestStoreFailureCode } from "./request-store-failures";

export type ContextAdmissionParticipantRole = "source" | "target";

export interface ParticipantContextAdmission {
  readonly role: ContextAdmissionParticipantRole;
  readonly admission: ContextAdmissionMetadata;
}

export interface ContextAdmissionParticipantQueryPort {
  getContextAdmissionForParticipant(input: {
    readonly workspaceKey: WorkspaceKey;
    readonly deliveryId: DeliveryId;
    readonly participantSessionId: SessionId;
  }): Promise<ParticipantContextAdmission | undefined>;
}

export type ContextAdmissionStoreResult =
  | { readonly ok: true; readonly admission: ContextAdmissionMetadata }
  | { readonly ok: false; readonly code: RequestStoreFailureCode };

export interface ContextSnapshotItem {
  readonly id: ContextAdmissionId;
  readonly kind: ContextAdmissionKind;
  readonly sourceSessionId: SessionId;
  readonly envelopeJson: string;
  readonly contentByteLength: number;
  readonly contentSha256: Sha256Digest;
}

export interface ContextReminderSnapshot {
  readonly activeLockCount: number;
  readonly availableResults: readonly Readonly<{
    requestId: RequestId;
    kind: "ask" | "wait";
  }>[];
}

export interface ContextAdmissionPersistencePort {
  createContextMessage(input: {
    readonly fencingToken: FencingToken;
    readonly id: DeliveryId;
    readonly workspaceKey: WorkspaceKey;
    readonly sourceSessionId: SessionId;
    readonly targetSessionId: SessionId;
    readonly envelopeJson: string;
    readonly contentByteLength: number;
    readonly contentSha256: Sha256Digest;
    readonly createdAtMs: number;
  }): Promise<ContextAdmissionStoreResult>;
  getContextAdmission(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly id: ContextAdmissionId;
  }): Promise<ContextAdmissionMetadata | undefined>;
  listPendingContext(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly targetSessionId: SessionId;
    readonly limit: number;
    readonly maximumBytes: number;
  }): Promise<readonly ContextSnapshotItem[]>;
  claimPendingContext(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly targetSessionId: SessionId;
    readonly items: readonly Readonly<{
      id: ContextAdmissionId;
      kind: ContextAdmissionKind;
      contentSha256: Sha256Digest;
    }>[];
  }): Promise<readonly ContextAdmissionMetadata[]>;
  readContextReminders(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly targetSessionId: SessionId;
    readonly resultLimit: number;
  }): Promise<ContextReminderSnapshot>;
  cancelContextAdmission(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly id: ContextAdmissionId;
  }): Promise<ContextAdmissionStoreResult>;
  failPendingContextForParticipant(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly participantSessionId: SessionId;
    readonly limit: number;
  }): Promise<readonly ContextAdmissionMetadata[]>;
  failUncertainContextOnStartup(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<readonly ContextAdmissionMetadata[]>;
}

/** Narrow participant-lifecycle settlement surface, separate from ordinary context delivery. */
export interface ParticipantContextPersistencePort {
  settlePendingContextForParticipant(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly participantSessionId: SessionId;
    /** Complete bounded terminal set; target membership takes precedence over source membership. */
    readonly terminalParticipantSessionIds: readonly SessionId[];
    readonly limit: number;
  }): Promise<readonly ContextAdmissionMetadata[]>;
}

export interface PrepareRequestContextAdmissionInput {
  readonly requestId: RequestId;
  readonly envelopeJson: string;
  readonly contentByteLength: number;
  readonly contentSha256: Sha256Digest;
}
