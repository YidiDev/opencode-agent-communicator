import {
  type SessionStopPorts,
  type SessionStopResult,
  stopSession,
} from "../application/stop-session";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionStopToolArguments,
  serializeDomainResult,
  sessionStopArgumentsSchema,
  sessionStopFailureCodes,
} from "./contracts";
import { invocationStopApproval } from "./invocation-stop-approval";
import { toolCallerSession } from "./tool-caller-session";

export function createSessionStopTool(
  ports: Omit<SessionStopPorts, "approval">,
  workspaceKey: WorkspaceKey,
  invocationDeadlineMs?: () => number,
): InternalToolContract<SessionStopToolArguments> {
  return {
    description:
      "Stop a visible root session after mandatory invocation-specific approval. Pending communicator requests are terminalized before any active native interruption.",
    args: sessionStopArgumentsSchema,
    async execute(arguments_, context) {
      const caller = toolCallerSession(context.sessionID);
      const deadlineMs = invocationDeadlineMs?.();
      if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)) {
        throw new Error("Stop invocation deadline is invalid.");
      }
      const result = caller.ok
        ? await stopSession(
            {
              ...ports,
              approval: invocationStopApproval(context, {
                workspaceKey,
                sourceSessionId: caller.value,
              }),
            },
            {
              workspaceKey,
              sourceSessionId: caller.value,
              abort: context.abort,
              ...(deadlineMs === undefined ? {} : { deadlineMs }),
            },
            arguments_,
          )
        : caller;
      return serializeDomainResult<SessionStopResult, Record<string, unknown>>(
        result,
        (value) => ({
          session_id: value.sessionId,
          communicator_state: {
            outcome: value.communicatorState.outcome,
            requests_terminalized: value.communicatorState.requestsTerminalized,
            target_stopped: value.communicatorState.targetStopped,
            source_stopped: value.communicatorState.sourceStopped,
          },
          native_outcome: value.nativeOutcome,
        }),
        sessionStopFailureCodes,
      );
    },
  };
}
