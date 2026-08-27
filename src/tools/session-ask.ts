import { askSession, type SessionAskResult } from "../application/ask-session";
import type { SessionBlockingRequestPorts } from "../application/create-blocking-session-request";
import type { PolicyDecision } from "../domain/authorization-policy";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import { invocationRequestAuthorization } from "./invocation-authorization";
import {
  type SessionAskToolArguments,
  sessionAskArgumentsSchema,
  sessionBlockingRequestFailureCodes,
} from "./request-contracts";
import {
  blockingRequestMinimumInvocationDurationMs,
  type RequestToolScope,
  requestToolContext,
} from "./request-tool-context";

export function createSessionAskTool(
  ports: Omit<SessionBlockingRequestPorts, "authorization">,
  scope: RequestToolScope,
  policy: PolicyDecision = "allow",
): InternalToolContract<SessionAskToolArguments> {
  return {
    description:
      "Ask an observed-active session structured questions and block for its durable answer. This never wakes an idle session.",
    args: sessionAskArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context, () =>
        blockingRequestMinimumInvocationDurationMs(arguments_.timeout_seconds),
      );
      const result = adapted.ok
        ? await askSession(
            {
              ...ports,
              authorization: invocationRequestAuthorization({ ask: policy, wait: "deny" }, context),
            },
            adapted.value,
            arguments_,
          )
        : adapted;
      return serializeDomainResult<SessionAskResult, SessionAskResult>(
        result,
        (value) => value,
        sessionBlockingRequestFailureCodes,
      );
    },
  };
}
