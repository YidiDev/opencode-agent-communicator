import {
  respondToSessionRequest,
  type SessionRespondPorts,
  type SessionRespondResult,
} from "../application/respond-to-session-request";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import {
  type SessionRespondToolArguments,
  sessionRespondArgumentsSchema,
  sessionRespondFailureCodes,
} from "./request-contracts";
import { type RequestToolScope, requestToolContext } from "./request-tool-context";

export function createSessionRespondTool(
  ports: SessionRespondPorts,
  scope: RequestToolScope,
): InternalToolContract<SessionRespondToolArguments> {
  return {
    description:
      'Answer a pending durable ask as its target. Answers are nested by question; for one question use answers: [["answer"]].',
    args: sessionRespondArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context);
      const result = adapted.ok
        ? await respondToSessionRequest(ports, adapted.value, arguments_)
        : adapted;
      return serializeDomainResult<SessionRespondResult, SessionRespondResult>(
        result,
        (value) => value,
        sessionRespondFailureCodes,
      );
    },
  };
}
