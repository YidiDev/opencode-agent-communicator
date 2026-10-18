import type { SessionSendPorts } from "../application/send-session-message";
import { sendSessionMessage } from "../application/send-session-message";
import type { PolicyDecision } from "../domain/authorization-policy";
import type { ContextAdmissionMetadata } from "../domain/context-admissions";
import type { DeliveryMetadata } from "../domain/deliveries";
import { domainFailure } from "../domain/results";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionSendToolArguments,
  serializeDomainResult,
  sessionSendArgumentsSchema,
  sessionSendFailureCodes,
} from "./contracts";
import { invocationMessageAuthorization } from "./invocation-authorization";
import { publicMessageDelivery } from "./public-values";

export function createSessionSendTool(
  ports: Omit<SessionSendPorts, "authorization">,
  workspaceKey: WorkspaceKey,
  policy: PolicyDecision = "allow",
  invocationDeadlineMs?: () => number,
): InternalToolContract<SessionSendToolArguments> {
  return {
    description:
      "Durably admit an asynchronous transcript-visible message to a visible root through the public queue. Delivery defaults to user. Admission does not prove activation or execution; session_list activity remains unknown. Explicit context delivery is unsupported on public v2 and returns target_status_unknown before an effect.",
    args: sessionSendArgumentsSchema,
    async execute(arguments_, context) {
      const source = validateSessionId(context.sessionID);
      const deadlineMs = invocationDeadlineMs?.();
      if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)) {
        throw new Error("Message invocation deadline is invalid.");
      }
      const result = source.ok
        ? await sendSessionMessage(
            { ...ports, authorization: invocationMessageAuthorization(policy) },
            {
              workspaceKey,
              sourceSessionId: source.value,
              abort: context.abort,
              ...(deadlineMs === undefined ? {} : { deadlineMs }),
            },
            arguments_,
          )
        : domainFailure("invalid_arguments", source.message, false);
      return serializeDomainResult<
        DeliveryMetadata | ContextAdmissionMetadata,
        Record<string, unknown>
      >(result, publicMessageDelivery, sessionSendFailureCodes);
    },
  };
}
