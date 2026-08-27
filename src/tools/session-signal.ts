import {
  type SessionSignalPorts,
  type SessionSignalResult,
  signalSessionRequest,
} from "../application/signal-session-request";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import {
  type SessionSignalToolArguments,
  sessionSignalArgumentsSchema,
  sessionSignalFailureCodes,
} from "./request-contracts";
import { type RequestToolScope, requestToolContext } from "./request-tool-context";

export function createSessionSignalTool(
  ports: SessionSignalPorts,
  scope: RequestToolScope,
): InternalToolContract<SessionSignalToolArguments> {
  return {
    description: "Signal a pending durable wait for which the calling session is the target.",
    args: sessionSignalArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context);
      const result = adapted.ok
        ? await signalSessionRequest(ports, adapted.value, arguments_)
        : adapted;
      return serializeDomainResult<SessionSignalResult, SessionSignalResult>(
        result,
        (value) => value,
        sessionSignalFailureCodes,
      );
    },
  };
}
