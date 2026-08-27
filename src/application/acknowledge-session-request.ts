import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { DomainResult } from "../domain/results";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
} from "./communicator-readiness-port";
import type { ClockPort, CurrentWorkspaceMembershipPort } from "./delivery-ports";
import type { RequestTerminalPersistencePort } from "./request-ports";
import {
  checkRequestMutationControl,
  hasExactKeys,
  hiddenRequestFailure,
  malformedRequestStoreFailure,
  parseTerminalFailure,
  requestMatchesParticipant,
  requestMutationStoreFailure,
  requireCurrentCaller,
  type SessionRequestMutationContext,
  thrownRequestStoreFailure,
  validateRequestMutation,
} from "./request-terminal-use-case";

export interface SessionRequestAckArguments {
  readonly request_id: unknown;
}

export interface SessionRequestAckResult {
  readonly request_id: string;
  readonly state: "acknowledged";
  readonly acknowledged_at_ms: number;
}

export interface SessionRequestAckPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly clock: ClockPort;
  readonly requests: RequestTerminalPersistencePort;
}

export async function acknowledgeSessionRequest(
  ports: SessionRequestAckPorts,
  context: SessionRequestMutationContext,
  args: SessionRequestAckArguments,
): Promise<DomainResult<SessionRequestAckResult>> {
  assertCommunicatorReady(ports.readiness, context.fencingToken);
  const identity = validateRequestMutation(context, args.request_id);
  if (!identity.ok) return identity;
  const current = await requireCurrentCaller(ports, context, identity.value.callerSessionId);
  if (!current.ok) return current;
  const dispatchControl = checkRequestMutationControl(ports, context);
  if (!dispatchControl.ok) return dispatchControl;
  try {
    const stored: unknown = await ports.requests.acknowledgeResult({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId: identity.value.requestId,
      callerSessionId: identity.value.callerSessionId,
    });
    if (!hasExactKeys(stored, ["ok", "outcome", "request"]) || stored.ok !== true) {
      const failure = parseTerminalFailure(stored);
      if (failure.kind === "hidden") return hiddenRequestFailure();
      if (failure.kind === "store") return requestMutationStoreFailure(failure.code);
      if (
        failure.kind === "authoritative" &&
        requestMatchesParticipant(
          failure.request,
          context.workspaceKey,
          identity.value.requestId,
          identity.value.callerSessionId,
          "source",
        )
      ) {
        return requestMutationStoreFailure("state_conflict");
      }
      return malformedRequestStoreFailure();
    }
    const request = stored.request;
    if (
      (stored.outcome !== "applied" && stored.outcome !== "idempotent") ||
      !isCoherentRequestMetadata(request) ||
      !requestMatchesParticipant(
        request,
        context.workspaceKey,
        identity.value.requestId,
        identity.value.callerSessionId,
        "source",
      )
    ) {
      return malformedRequestStoreFailure();
    }
    if (
      (request.resolutionState !== "answered" && request.resolutionState !== "reached") ||
      request.resultState !== "acknowledged" ||
      !Number.isSafeInteger(request.acknowledgedAtMs)
    ) {
      return malformedRequestStoreFailure();
    }
    return {
      ok: true,
      value: {
        request_id: identity.value.requestId,
        state: "acknowledged",
        acknowledged_at_ms: request.acknowledgedAtMs,
      },
    };
  } catch (cause: unknown) {
    return thrownRequestStoreFailure(cause);
  }
}
