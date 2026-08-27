import type { Sha256Digest } from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import type { RequestMetadata } from "../domain/request-types";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { OperationControl } from "./delivery-ports";

export interface SessionStopApprovalPort {
  requestStopApproval(
    binding: {
      readonly workspaceKey: WorkspaceKey;
      readonly sourceSessionId: SessionId;
      readonly targetSessionId: SessionId;
      readonly reasonSha256: Sha256Digest;
    },
    control: OperationControl,
  ): Promise<"approved" | "rejected">;
}

export type StopPendingRequestsResult =
  | {
      readonly ok: true;
      /** Complete bounded metadata copied out only after the transaction committed. */
      readonly terminalized: readonly RequestMetadata[];
    }
  | { readonly ok: false; readonly code: "ownership_lost" | "storage_unavailable" };

export interface SessionStopPersistencePort {
  stopPendingRequests(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly stoppedSessionId: SessionId;
  }): Promise<StopPendingRequestsResult>;
}

export type NativeInterruptOutcome = "interrupted" | "unknown";

export interface NativeSessionInterruptPort {
  interruptSession(input: {
    readonly targetSessionId: SessionId;
    readonly abort: AbortSignal;
  }): Promise<NativeInterruptOutcome>;
}
