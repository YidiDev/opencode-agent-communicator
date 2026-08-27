import {
  acknowledgeSessionRequest,
  type SessionRequestAckPorts,
  type SessionRequestAckResult,
} from "../application/acknowledge-session-request";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import {
  type SessionRequestAckToolArguments,
  sessionRequestAckArgumentsSchema,
  sessionRequestAckFailureCodes,
} from "./request-contracts";
import { type RequestToolScope, requestToolContext } from "./request-tool-context";

export function createSessionRequestAckTool(
  ports: SessionRequestAckPorts,
  scope: RequestToolScope,
): InternalToolContract<SessionRequestAckToolArguments> {
  return {
    description: "Acknowledge and erase a retained answer or milestone result as its source.",
    args: sessionRequestAckArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context);
      const result = adapted.ok
        ? await acknowledgeSessionRequest(ports, adapted.value, arguments_)
        : adapted;
      return serializeDomainResult<SessionRequestAckResult, SessionRequestAckResult>(
        result,
        (value) => value,
        sessionRequestAckFailureCodes,
      );
    },
  };
}
