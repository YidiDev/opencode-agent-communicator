import {
  type SessionRequestStartPorts,
  startSessionRequest,
} from "../application/start-session-request";
import type { PolicyDecision } from "../domain/authorization-policy";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { PendingRequestPayload } from "../domain/request-types";
import { isCoherentStartOperation } from "../domain/session-start";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionRequestStartToolArguments,
  serializeDomainResult,
  sessionRequestStartArgumentsSchema,
  sessionStartFailureCodes,
} from "./contracts";
import { invocationRequestAuthorization } from "./invocation-authorization";
import { invocationStartApproval } from "./invocation-start-approval";
import { publicCreatedRequest, publicStartOperation } from "./public-values";
import { sessionBlockingRequestFailureCodes } from "./request-contracts";
import { requestToolContext } from "./request-tool-context";

function payload(request: SessionRequestStartToolArguments["request"]): PendingRequestPayload {
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

export function createSessionRequestStartTool(
  ports: Omit<SessionRequestStartPorts, "approval" | "requestAuthorization">,
  scope: {
    readonly workspaceKey: WorkspaceKey;
    readonly fencingToken: number;
    readonly invocationDeadlineMs: () => number;
  },
  policies: Readonly<{ ask: PolicyDecision; wait: PolicyDecision }>,
): InternalToolContract<SessionRequestStartToolArguments> {
  return {
    description:
      "Create a managed root and atomically associate its initial work with a durable ask or wait request before native creation. Returns recoverable operation and request metadata.",
    args: sessionRequestStartArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(
        scope as Parameters<typeof requestToolContext>[0],
        context,
      );
      const result = adapted.ok
        ? await startSessionRequest(
            {
              ...ports,
              approval: invocationStartApproval(context),
              requestAuthorization: invocationRequestAuthorization(policies, context),
            },
            adapted.value,
            {
              ...arguments_,
              request: payload(arguments_.request),
            },
          )
        : adapted;
      if (!result.ok && result.error.details) {
        const operation = result.error.details.operation;
        const request = result.error.details.request;
        if (isCoherentStartOperation(operation) && isCoherentRequestMetadata(request)) {
          return JSON.stringify({
            ok: false,
            error: {
              ...result.error,
              details: {
                operation: publicStartOperation(operation),
                request: publicCreatedRequest(request),
              },
            },
          });
        }
      }
      return serializeDomainResult(
        result,
        (value) => ({
          operation: publicStartOperation(value.operation),
          request: publicCreatedRequest(value.request),
        }),
        [...new Set([...sessionStartFailureCodes, ...sessionBlockingRequestFailureCodes])],
      );
    },
  };
}
