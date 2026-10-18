import {
  type SessionRequestStartPorts,
  type SessionRequestStartResult,
  startSessionRequest,
} from "../application/start-session-request";
import type { PolicyDecision } from "../domain/authorization-policy";
import type { PendingRequestPayload } from "../domain/request-types";
import type { DomainFailureCode, DomainResult } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionRequestStartToolArguments,
  sessionRequestStartArgumentsSchema,
  sessionStartFailureCodes,
  ToolContractFault,
} from "./contracts";
import { invocationRequestAuthorization } from "./invocation-authorization";
import { publicCreatedRequest, publicStartOperation } from "./public-values";
import { sessionBlockingRequestFailureCodes } from "./request-contracts";
import { requestToolContext } from "./request-tool-context";
import {
  exactRecordWithOptionalKeys,
  exactRequestMetadata,
  exactStartOperation,
  exactToolFailure,
  exactToolSuccess,
} from "./session-result-contracts";

const sessionRequestStartFailureCodes = [
  ...new Set([...sessionStartFailureCodes, ...sessionBlockingRequestFailureCodes]),
] as readonly DomainFailureCode[];

export function serializeSessionRequestStartResult(
  result: DomainResult<SessionRequestStartResult>,
  expected: {
    readonly workspaceKey: WorkspaceKey;
    readonly sourceSessionId: string;
    readonly idempotencyKey: string;
  },
): string {
  const success = exactToolSuccess(result);
  if (success) {
    const value = exactRecordWithOptionalKeys(success.value, ["operation", "request"], []);
    const operation = exactStartOperation(value?.operation);
    const request = exactRequestMetadata(value?.request);
    if (!operation || !request || !isExpectedComposite(operation, request, expected)) {
      throw new ToolContractFault();
    }
    return JSON.stringify({
      ok: true,
      value: {
        operation: publicStartOperation(operation),
        request: publicCreatedRequest(request),
      },
    });
  }
  const failure = exactToolFailure(result, sessionRequestStartFailureCodes);
  if (!failure) throw new ToolContractFault();
  const publicError = {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
  if (failure.details === undefined) return JSON.stringify({ ok: false, error: publicError });
  const details = exactRecordWithOptionalKeys(failure.details, ["operation", "request"], []);
  if (!details) throw new ToolContractFault();
  try {
    const operation = exactStartOperation(details.operation);
    const request = exactRequestMetadata(details.request);
    if (!operation || !request || !isExpectedComposite(operation, request, expected)) {
      throw new ToolContractFault();
    }
    return JSON.stringify({
      ok: false,
      error: {
        ...publicError,
        details: {
          operation: publicStartOperation(operation),
          request: publicCreatedRequest(request),
        },
      },
    });
  } catch (cause: unknown) {
    if (cause instanceof ToolContractFault) throw cause;
    throw new ToolContractFault();
  }
}

function isExpectedComposite(
  operation: import("../domain/session-start").StartOperation,
  request: import("../domain/request-types").RequestMetadata,
  expected: {
    readonly workspaceKey: WorkspaceKey;
    readonly sourceSessionId: string;
    readonly idempotencyKey: string;
  },
): boolean {
  return (
    operation.workspaceKey === expected.workspaceKey &&
    operation.sourceSessionId === expected.sourceSessionId &&
    operation.idempotencyKey === expected.idempotencyKey &&
    request.workspaceKey === expected.workspaceKey &&
    request.sourceSessionId === expected.sourceSessionId &&
    request.targetSessionId === operation.sessionId &&
    request.linkedStartOperationId === operation.id &&
    request.nativeMessageId === operation.nativeMessageId &&
    request.deliveryMode === "initial"
  );
}

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
      "Create a managed root under explicit static policy and atomically associate its initial work with a durable ask or wait request before the public native creation operation.",
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
              approval: { requestStartApproval: async () => "rejected" },
              requestAuthorization: invocationRequestAuthorization(policies),
            },
            adapted.value,
            {
              ...arguments_,
              request: payload(arguments_.request),
            },
          )
        : adapted;
      return serializeSessionRequestStartResult(result, {
        workspaceKey: scope.workspaceKey,
        sourceSessionId: adapted.ok ? adapted.value.sourceSessionId : context.sessionID,
        idempotencyKey: arguments_.idempotency_key,
      });
    },
  };
}
