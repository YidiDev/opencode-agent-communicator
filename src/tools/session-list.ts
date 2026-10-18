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
      "List communicator-observed root candidates after current visibility revalidation. Public v2 activity is unknown. Use explicit session_send user delivery or queue-based ask or wait with current visibility; admission never proves execution.",
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
