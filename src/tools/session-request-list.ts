import {
  listSessionRequests,
  type SessionRequestListPorts,
  type SessionRequestListResult,
} from "../application/list-session-requests";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import { publicRequestMetadata } from "./public-values";
import {
  type SessionRequestListToolArguments,
  sessionRequestListArgumentsSchema,
  sessionRequestListFailureCodes,
} from "./request-contracts";
import { type RequestToolScope, requestToolContext } from "./request-tool-context";

export function createSessionRequestListTool(
  ports: SessionRequestListPorts,
  scope: RequestToolScope,
): InternalToolContract<SessionRequestListToolArguments> {
  return {
    description:
      "List payload-free durable request metadata visible to the calling session's inbox or outbox role.",
    args: sessionRequestListArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context);
      const result = adapted.ok
        ? await listSessionRequests(ports, adapted.value, arguments_)
        : adapted;
      return serializeDomainResult<SessionRequestListResult, Record<string, unknown>>(
        result,
        (value) => ({
          items: value.items.map(publicRequestMetadata),
          ...(value.nextCursor === undefined ? {} : { next_cursor: value.nextCursor }),
        }),
        sessionRequestListFailureCodes,
      );
    },
  };
}
