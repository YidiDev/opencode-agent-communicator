import {
  listVisibleRootSessions,
  type SessionListPorts,
  type VisibleRootSession,
} from "../application/list-visible-root-sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionListToolArguments,
  serializeDomainResult,
  sessionListArgumentsSchema,
  sessionListFailureCodes,
} from "./contracts";
import { publicSession } from "./public-values";

export function createSessionListTool(
  ports: SessionListPorts,
  workspaceKey: WorkspaceKey,
  invocationDeadlineMs?: () => number,
): InternalToolContract<SessionListToolArguments> {
  return {
    description:
      "List current visible root sessions. Busy or retry accepts default context delivery; idle requires explicit session_send user delivery to wake. Confirm busy or retry, then ask or wait.",
    args: sessionListArgumentsSchema,
    async execute(arguments_, context) {
      const deadlineMs = invocationDeadlineMs?.();
      if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)) {
        throw new Error("Session list invocation deadline is invalid.");
      }
      const result = await listVisibleRootSessions(
        ports,
        {
          workspaceKey,
          sourceSessionId: context.sessionID,
          abort: context.abort,
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
        },
        {
          ...(arguments_.status === undefined ? {} : { status: arguments_.status }),
          ...(arguments_.include_archived === undefined
            ? {}
            : { includeArchived: arguments_.include_archived }),
          ...(arguments_.limit === undefined ? {} : { limit: arguments_.limit }),
        },
      );
      return serializeDomainResult<
        readonly VisibleRootSession[],
        readonly Record<string, unknown>[]
      >(result, (items) => items.map(publicSession), sessionListFailureCodes);
    },
  };
}
