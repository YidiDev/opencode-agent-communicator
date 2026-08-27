import { runUntilAborted } from "../application/abortable-operation";
import type {
  ExportApprovalBinding,
  ExportApprovalKind,
  SessionExportApprovalPort,
} from "../application/session-export-ports";
import type { StructuralToolContext } from "./contracts";
import { ToolContractFault } from "./contracts";

function approvalResource(
  kind: ExportApprovalKind,
  binding: ExportApprovalBinding,
  deadlineMs: number | undefined,
): string {
  return [
    "op=session_export",
    `approval=${kind}`,
    `workspace=${encodeURIComponent(binding.workspaceKey)}`,
    `source=${binding.sourceSessionId}`,
    `target=${binding.targetSessionId}`,
    `destination=${encodeURIComponent(binding.destination)}`,
    `sanitize=${String(binding.isSanitized)}`,
    `overwrite=${String(binding.shouldOverwrite)}`,
    `deadline_ms=${deadlineMs ?? "none"}`,
  ].join(";");
}

export function invocationExportApproval(
  context: StructuralToolContext,
): SessionExportApprovalPort {
  const requested = new Set<ExportApprovalKind>();
  return Object.freeze({
    async requestExportApproval(
      kind: ExportApprovalKind,
      binding: ExportApprovalBinding,
      control: Parameters<SessionExportApprovalPort["requestExportApproval"]>[2],
    ) {
      if (requested.has(kind) || typeof context.ask !== "function") throw new ToolContractFault();
      requested.add(kind);
      if (control.abort.aborted) return "rejected";
      try {
        const result = await runUntilAborted(
          control.abort,
          () =>
            context.ask?.({
              permission: kind === "overwrite" ? "session_export_overwrite" : "session_export",
              patterns: [approvalResource(kind, binding, control.deadlineMs)],
              always: [],
              metadata: {
                operation: "session_export",
                approval_kind: kind,
                workspace_key: binding.workspaceKey,
                source_session_id: binding.sourceSessionId,
                target_session_id: binding.targetSessionId,
                destination: binding.destination,
                sanitize: binding.isSanitized,
                overwrite: binding.shouldOverwrite,
                deadline_ms: control.deadlineMs ?? null,
                ...(context.messageID === undefined
                  ? {}
                  : { invocation_message_id: context.messageID }),
              },
            }) ?? Promise.reject(new ToolContractFault()),
        );
        return result.kind === "settled" && !control.abort.aborted ? "approved" : "rejected";
      } catch {
        return "rejected";
      }
    },
  });
}
