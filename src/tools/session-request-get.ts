import { getSessionRequest, type SessionRequestGetPorts } from "../application/get-session-request";
import type { ParticipantRequestGet } from "../application/request-ports";
import { type InternalToolContract, serializeDomainResult } from "./contracts";
import { publicParticipantRequest } from "./public-values";
import {
  type SessionRequestGetToolArguments,
  sessionRequestGetArgumentsSchema,
  sessionRequestGetFailureCodes,
} from "./request-contracts";
import { type RequestToolScope, requestToolContext } from "./request-tool-context";

export function createSessionRequestGetTool(
  ports: SessionRequestGetPorts,
  scope: RequestToolScope,
): InternalToolContract<SessionRequestGetToolArguments> {
  return {
    description:
      "Retrieve an authorized pending inbox payload or retained outbox result for a durable request.",
    args: sessionRequestGetArgumentsSchema,
    async execute(arguments_, context) {
      const adapted = requestToolContext(scope, context);
      const result = adapted.ok
        ? await getSessionRequest(ports, adapted.value, arguments_)
        : adapted;
      return serializeDomainResult<ParticipantRequestGet, Record<string, unknown>>(
        result,
        publicParticipantRequest,
        sessionRequestGetFailureCodes,
      );
    },
  };
}
