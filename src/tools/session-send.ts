import type { SessionSendPorts } from "../application/send-session-message";
import { sendSessionMessage } from "../application/send-session-message";
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
import { publicDelivery } from "./public-values";

export function createSessionSendTool(
  ports: SessionSendPorts,
  workspaceKey: WorkspaceKey,
): InternalToolContract<SessionSendToolArguments> {
  return {
    description:
      "Queue a message for a visible root session. Admission does not prove activation; inspect session_list until busy or retry before asking or waiting.",
    args: sessionSendArgumentsSchema,
    async execute(arguments_, context) {
      const source = validateSessionId(context.sessionID);
      const result = source.ok
        ? await sendSessionMessage(
            ports,
            {
              workspaceKey,
              sourceSessionId: source.value,
              abort: context.abort,
            },
            arguments_,
          )
        : domainFailure("invalid_arguments", source.message, false);
      return serializeDomainResult<DeliveryMetadata, Record<string, unknown>>(
        result,
        publicDelivery,
        sessionSendFailureCodes,
      );
    },
  };
}
