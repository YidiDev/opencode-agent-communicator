import { exportSession } from "../application/export-session";
import type { SessionExportPorts } from "../application/session-export-ports";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionExportToolArguments,
  serializeDomainResult,
  sessionExportArgumentsSchema,
  sessionExportFailureCodes,
  ToolContractFault,
} from "./contracts";
import { invocationExportApproval } from "./invocation-export-approval";
import { publicSessionExport } from "./public-values";
import { toolCallerSession } from "./tool-caller-session";

export interface SessionExportToolScope {
  readonly workspaceKey: WorkspaceKey;
  readonly invocationDeadlineMs: () => number;
}

export function createSessionExportTool(
  ports: Omit<SessionExportPorts, "approval">,
  scope: SessionExportToolScope,
): InternalToolContract<SessionExportToolArguments> {
  return {
    description:
      "Export a visible root session through the exact native sanitizer into a contained private destination. Returns summary metadata only.",
    args: sessionExportArgumentsSchema,
    async execute(arguments_, context) {
      const caller = toolCallerSession(context.sessionID);
      let deadlineMs: number;
      try {
        deadlineMs = scope.invocationDeadlineMs();
      } catch {
        throw new ToolContractFault();
      }
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new ToolContractFault();
      const result = caller.ok
        ? await exportSession(
            { ...ports, approval: invocationExportApproval(context) },
            {
              workspaceKey: scope.workspaceKey,
              sourceSessionId: caller.value,
              abort: context.abort,
              deadlineMs,
            },
            arguments_,
          )
        : caller;
      return serializeDomainResult(result, publicSessionExport, sessionExportFailureCodes);
    },
  };
}
