import { type SessionStartPorts, startSession } from "../application/start-session";
import type { DomainFailureCode } from "../domain/results";
import { isCoherentStartOperation, type StartOperation } from "../domain/session-start";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionStartToolArguments,
  serializeDomainResult,
  sessionStartArgumentsSchema,
  sessionStartFailureCodes,
  ToolContractFault,
} from "./contracts";
import { invocationStartApproval } from "./invocation-start-approval";
import { publicStartOperation } from "./public-values";
import { toolCallerSession } from "./tool-caller-session";

export interface SessionStartToolScope {
  readonly workspaceKey: WorkspaceKey;
  readonly invocationDeadlineMs: () => number;
}

export function createSessionStartTool(
  ports: Omit<SessionStartPorts, "approval">,
  scope: SessionStartToolScope,
): InternalToolContract<SessionStartToolArguments> {
  return {
    description:
      "Create one managed root session with durable source-scoped idempotency and mandatory invocation-specific approval by default.",
    args: sessionStartArgumentsSchema,
    async execute(arguments_, context) {
      const caller = toolCallerSession(context.sessionID);
      let deadlineMs: number;
      try {
        deadlineMs = scope.invocationDeadlineMs();
      } catch {
        throw new ToolContractFault();
      }
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new ToolContractFault();
      const result = caller.ok
        ? await startSession(
            { ...ports, approval: invocationStartApproval(context) },
            {
              workspaceKey: scope.workspaceKey,
              sourceSessionId: caller.value,
              abort: context.abort,
              deadlineMs,
            },
            arguments_,
          )
        : caller;
      if (!result.ok && result.error.details?.operation !== undefined) {
        if (
          !(sessionStartFailureCodes as readonly DomainFailureCode[]).includes(result.error.code) ||
          !isCoherentStartOperation(result.error.details.operation)
        ) {
          throw new ToolContractFault();
        }
        const operation = result.error.details.operation;
        return JSON.stringify({
          ok: false,
          error: {
            ...result.error,
            details: { operation: publicStartOperation(operation) },
          },
        });
      }
      return serializeDomainResult<StartOperation, Record<string, unknown>>(
        result,
        publicStartOperation,
        sessionStartFailureCodes,
      );
    },
  };
}
