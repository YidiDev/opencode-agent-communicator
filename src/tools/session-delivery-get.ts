import type { SessionDeliveryGetPorts } from "../application/get-session-delivery";
import { getSessionDelivery } from "../application/get-session-delivery";
import type { ParticipantDelivery } from "../domain/deliveries";
import { domainFailure } from "../domain/results";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionDeliveryGetToolArguments,
  serializeDomainResult,
  sessionDeliveryGetArgumentsSchema,
  sessionDeliveryGetFailureCodes,
} from "./contracts";
import { publicParticipantDelivery } from "./public-values";

export function createSessionDeliveryGetTool(
  ports: SessionDeliveryGetPorts,
  workspaceKey: WorkspaceKey,
  invocationDeadlineMs?: () => number,
): InternalToolContract<SessionDeliveryGetToolArguments> {
  return {
    description:
      "Inspect payload-free queue delivery metadata. After admission, inspect session_list for busy or retry before asking or waiting.",
    args: sessionDeliveryGetArgumentsSchema,
    async execute(arguments_, context) {
      const source = validateSessionId(context.sessionID);
      const deadlineMs = invocationDeadlineMs?.();
      if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)) {
        throw new Error("Delivery query invocation deadline is invalid.");
      }
      const result = source.ok
        ? await getSessionDelivery(
            ports,
            {
              workspaceKey,
              sourceSessionId: source.value,
              abort: context.abort,
              ...(deadlineMs === undefined ? {} : { deadlineMs }),
            },
            arguments_,
          )
        : domainFailure("invalid_arguments", source.message, false);
      return serializeDomainResult<ParticipantDelivery, Record<string, unknown>>(
        result,
        publicParticipantDelivery,
        sessionDeliveryGetFailureCodes,
      );
    },
  };
}
