import {
  cancelSessionRequest,
  type SessionRequestCancelPorts,
  type SessionRequestCancelResult,
} from "../application/cancel-session-request";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import {
  type SessionRequestCancelToolArguments,
  sessionRequestCancelArgumentsSchema,
  sessionRequestCancelFailureCodes,
} from "./request-contracts";
import { type RequestToolScope, requestToolContext } from "./request-tool-context";

export function createSessionRequestCancelTool(
  ports: SessionRequestCancelPorts,
  scope: RequestToolScope,
): InternalToolContract<SessionRequestCancelToolArguments> {
  return {
    description:
      "Cancel one pending durable request as its source. Repeated cancellation succeeds.",
    args: sessionRequestCancelArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context);
      const result = adapted.ok
        ? await cancelSessionRequest(ports, adapted.value, arguments_)
        : adapted;
      return serializeDomainResult<SessionRequestCancelResult, SessionRequestCancelResult>(
        result,
        (value) => value,
        sessionRequestCancelFailureCodes,
      );
    },
  };
}
