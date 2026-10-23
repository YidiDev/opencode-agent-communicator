import type { Sha256Digest, Sha256DigestPort } from "../domain/message-payload";
import type { ProjectionSafeMessage, SessionReadDirection } from "../domain/session-read";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorReadinessPort } from "./communicator-readiness-port";
import type { ClockPort, OperationControl, SessionReadPresencePort } from "./delivery-ports";

interface NativeSessionReadRequest {
  readonly workspaceKey: WorkspaceKey;
  readonly sessionId: SessionId;
  readonly abort: AbortSignal;
  /** Remaining serialized projection allowance, applied after the public host materializes context. */
  readonly maximumResponseBytes?: number;
}

export type NativeMessagePageRequest = NativeSessionReadRequest &
  (
    | {
        readonly cursor?: null;
        readonly order: "asc" | "desc";
      }
    | {
        readonly cursor: string;
        readonly order?: never;
      }
  );

export interface NativeFixedMessageRequest extends NativeSessionReadRequest {
  readonly messageId: string;
}

export interface NativeMessagePage {
  /** Older current-context entries were deliberately excluded from the bounded tail. */
  readonly earlierContextUnavailable?: boolean;
  readonly messages: readonly ProjectionSafeMessage[];
  /** Every raw native message ID in exact native order, including omitted variants. */
  readonly examinedMessageIds: readonly string[];
  /** Counts every raw native page entry, including deliberately omitted variants. */
  readonly examinedMessageCount: number;
  /** Exact UTF-8 bytes in projection-safe assistant text retained by this DTO. */
  readonly projectedTextByteCount: number;
  /** UTF-8 bytes of the entire restricted snapshot processed by this call, not transport bytes. */
  readonly rawResponseByteCount: number;
  /** Counts every assistant content part examined, including omitted parts. */
  readonly examinedPartCount: number;
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
}

export type NativeFixedMessageResult =
  | {
      readonly kind: "found";
      readonly message: ProjectionSafeMessage;
      readonly projectedTextByteCount: number;
      readonly rawResponseByteCount: number;
      readonly examinedPartCount: number;
    }
  | { readonly kind: "not_found"; readonly rawResponseByteCount: number };

/** Native transcript reads can return only the deliberately restricted projection DTO. */
export interface NativeSessionReadPort {
  readMessagePage(request: NativeMessagePageRequest): Promise<NativeMessagePage>;
  readMessage(request: NativeFixedMessageRequest): Promise<NativeFixedMessageResult>;
}

export type SessionReadMode = "tail" | SessionReadDirection;

/** Exact approval resource. It deliberately carries only a digest of a supplied cursor. */
export interface SessionReadApprovalBinding {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly projectionVersion: number;
  readonly mode: SessionReadMode;
  readonly lineLimit: number;
  readonly aggregateByteCap: number;
  readonly cursorSha256?: Sha256Digest;
}

export interface SessionReadApprovalPort {
  requestReadApproval(
    binding: SessionReadApprovalBinding,
    control: OperationControl,
  ): Promise<"approved" | "rejected">;
}

export interface SessionReadTimerHandle {
  cancel(): void;
}

export interface SessionReadTimerPort {
  arm(delayMs: number, wake: () => void): SessionReadTimerHandle;
}

export interface SessionReadPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: SessionReadPresencePort;
  readonly approval: SessionReadApprovalPort;
  readonly native: NativeSessionReadPort;
  readonly digest: Sha256DigestPort;
  readonly clock: ClockPort;
  readonly timer: SessionReadTimerPort;
}
