import {
  createImmediateSessionRequest,
  type ImmediateSessionRequestPorts,
} from "../application/create-immediate-session-request";
import type { PolicyDecision } from "../domain/authorization-policy";
import type { PendingRequestPayload, RequestMetadata } from "../domain/request-types";
import { domainFailure } from "../domain/results";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import {
  invocationMessageAuthorization,
  invocationRequestAuthorization,
} from "./invocation-authorization";
import { publicCreatedRequest } from "./public-values";
import {
  type SessionRequestSendToolArguments,
  sessionRequestSendArgumentsSchema,
  sessionRequestSendFailureCodes,
} from "./request-contracts";
import { type RequestToolScope, requestToolContext } from "./request-tool-context";

function payload(request: SessionRequestSendToolArguments["request"]): PendingRequestPayload {
  return request.kind === "ask"
    ? {
        kind: "ask",
        questions: request.questions.map((question) => ({
          prompt: question.prompt,
          options: question.options,
          multiple: question.multiple ?? false,
          allowCustom: question.allow_custom ?? false,
        })),
        timeoutSeconds: request.timeout_seconds,
      }
    : { kind: "wait", milestone: request.milestone, timeoutSeconds: request.timeout_seconds };
}

export function createSessionRequestSendTool(
  ports: Omit<ImmediateSessionRequestPorts, "messageAuthorization" | "requestAuthorization">,
  scope: RequestToolScope & { readonly workspaceKey: WorkspaceKey },
  policies: Readonly<{ message: PolicyDecision; ask: PolicyDecision; wait: PolicyDecision }>,
): InternalToolContract<SessionRequestSendToolArguments> {
  return {
    description:
      "Durably admit work and an ask or wait request to a visible root through the public queue. Returns recoverable request metadata immediately; admission is distinct from activation.",
    args: sessionRequestSendArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context);
      const request = payload(arguments_.request);
      const target = validateSessionId(arguments_.session_id);
      const result =
        adapted.ok && target.ok
          ? await createImmediateSessionRequest(
              {
                ...ports,
                messageAuthorization: invocationMessageAuthorization(policies.message),
                requestAuthorization: invocationRequestAuthorization({
                  ask: policies.ask,
                  wait: policies.wait,
                }),
              },
              adapted.value,
              { session_id: target.value, content: arguments_.content, request },
            )
          : adapted.ok
            ? domainFailure(
                "invalid_arguments",
                target.ok ? "Target session is malformed." : target.message,
                false,
              )
            : adapted;
      return serializeDomainResult<RequestMetadata, Record<string, unknown>>(
        result,
        publicCreatedRequest,
        sessionRequestSendFailureCodes,
      );
    },
  };
}
