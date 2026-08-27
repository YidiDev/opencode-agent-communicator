import type { Sha256Digest } from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import type {
  ExportDestination,
  ExportPolicyDecision,
  SessionExportSummary,
} from "../domain/session-export";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { OperationControl, OwnershipPort } from "./delivery-ports";

export interface ExportApprovalBinding {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly destination: ExportDestination;
  readonly isSanitized: boolean;
  readonly shouldOverwrite: boolean;
}

export type ExportApprovalKind = "mode" | "overwrite";

export interface SessionExportApprovalPort {
  requestExportApproval(
    kind: ExportApprovalKind,
    binding: ExportApprovalBinding,
    control: OperationControl,
  ): Promise<"approved" | "rejected">;
}

export interface SessionExportPolicyPort {
  decisionFor(input: {
    readonly isSelf: boolean;
    readonly isSanitized: boolean;
    readonly shouldOverwrite: boolean;
  }): {
    readonly mode: ExportPolicyDecision;
    readonly overwrite?: ExportPolicyDecision;
  };
}

export interface ExportEffectGuardPort {
  check(): Promise<
    | "current"
    | "caller_not_visible"
    | "target_not_visible"
    | "ownership_lost"
    | "export_unavailable"
  >;
}

export type ExportAdapterFailureCode =
  | "caller_not_visible"
  | "target_not_visible"
  | "export_unavailable"
  | "unsafe_path"
  | "destination_exists"
  | "export_limit_exceeded"
  | "native_outcome_unknown"
  | "ownership_lost"
  | "storage_unavailable";

export type ExportAdapterResult =
  | { readonly ok: true; readonly byteCount: number; readonly contentSha256: Sha256Digest }
  | { readonly ok: false; readonly code: ExportAdapterFailureCode };

export interface SessionExportAdapterPort {
  writeExport(input: {
    readonly sessionId: SessionId;
    readonly sourceSessionId: SessionId;
    readonly workspaceKey: WorkspaceKey;
    readonly destination: ExportDestination;
    readonly isSanitized: boolean;
    readonly shouldOverwrite: boolean;
    readonly abort: AbortSignal;
    readonly deadlineMs: number;
    readonly fencingToken: FencingToken;
    readonly guard: ExportEffectGuardPort;
  }): Promise<ExportAdapterResult>;
}

export interface SessionExportPorts {
  readonly readiness: import("./communicator-readiness-port").CommunicatorReadinessPort;
  readonly membership: import("./delivery-ports").CurrentWorkspaceMembershipPort;
  readonly ownership: OwnershipPort;
  readonly policy: SessionExportPolicyPort;
  readonly approval: SessionExportApprovalPort;
  readonly exporter: SessionExportAdapterPort;
}

export type { SessionExportSummary };
