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
): InternalToolContract<SessionListToolArguments> {
  return {
    description:
      "List current visible root sessions. Queue with session_send, inspect status here until busy or retry, then ask or wait.",
    args: sessionListArgumentsSchema,
    async execute(arguments_, context) {
      const result = await listVisibleRootSessions(
        ports,
        { workspaceKey, sourceSessionId: context.sessionID },
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
