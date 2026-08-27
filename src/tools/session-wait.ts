import type { SessionBlockingRequestPorts } from "../application/create-blocking-session-request";
import { type SessionWaitResult, waitSession } from "../application/wait-session";
import type { PolicyDecision } from "../domain/authorization-policy";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import { invocationRequestAuthorization } from "./invocation-authorization";
import {
  type SessionWaitToolArguments,
  sessionBlockingRequestFailureCodes,
  sessionWaitArgumentsSchema,
} from "./request-contracts";
import {
  blockingRequestMinimumInvocationDurationMs,
  type RequestToolScope,
  requestToolContext,
} from "./request-tool-context";

export function createSessionWaitTool(
  ports: Omit<SessionBlockingRequestPorts, "authorization">,
  scope: RequestToolScope,
  policy: PolicyDecision = "allow",
): InternalToolContract<SessionWaitToolArguments> {
  return {
    description:
      "Wait for an observed-active session to signal a durable milestone. This never wakes an idle session.",
    args: sessionWaitArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context, () =>
        blockingRequestMinimumInvocationDurationMs(arguments_.timeout_seconds),
      );
      const result = adapted.ok
        ? await waitSession(
            {
              ...ports,
              authorization: invocationRequestAuthorization({ ask: "deny", wait: policy }, context),
            },
            adapted.value,
            arguments_,
          )
        : adapted;
      return serializeDomainResult<SessionWaitResult, SessionWaitResult>(
        result,
        (value) => value,
        sessionBlockingRequestFailureCodes,
      );
    },
  };
}
