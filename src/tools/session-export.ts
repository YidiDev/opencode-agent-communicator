import { exportSession } from "../application/export-session";
import type { SessionExportPorts } from "../application/session-export-ports";
import { domainFailure } from "../domain/results";
import { validateExportDestination } from "../domain/session-export";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionExportToolArguments,
  serializeDomainResult,
  sessionExportArgumentsSchema,
  sessionExportFailureCodes,
  ToolContractFault,
} from "./contracts";
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
      "Export a versioned sanitized projection of a visible root session's current model context plus bounded communicator metadata into a contained private destination. Returns summary metadata only.",
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
      const target = caller.ok ? validateSessionId(arguments_.session_id ?? caller.value) : caller;
      const destination = validateExportDestination(arguments_.destination);
      const validModes = arguments_.sanitize === true && typeof arguments_.overwrite === "boolean";
      const result =
        caller.ok && target.ok && destination.ok && validModes
          ? await exportSession(
              {
                ...ports,
                approval: { requestExportApproval: async () => "rejected" },
              },
              {
                workspaceKey: scope.workspaceKey,
                sourceSessionId: caller.value,
                abort: context.abort,
                deadlineMs,
              },
              arguments_,
            )
          : caller.ok
            ? domainFailure("invalid_arguments", "Session export arguments are malformed.", false)
            : caller;
      return serializeDomainResult(result, publicSessionExport, sessionExportFailureCodes);
    },
  };
}
