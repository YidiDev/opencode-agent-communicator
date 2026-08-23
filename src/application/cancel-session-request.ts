import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata, RequestResolutionState } from "../domain/request-types";
import type { DomainResult } from "../domain/results";
import type { ClockPort, CurrentWorkspaceMembershipPort } from "./delivery-ports";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type { RequestTerminalPersistencePort } from "./request-ports";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import {
  assertRequestMutationControl,
  hasExactKeys,
  hiddenRequestFailure,
  malformedRequestStoreFailure,
  parseTerminalFailure,
  requestMatchesParticipant,
  requestMutationStoreFailure,
  requireCurrentCaller,
  type SessionRequestMutationContext,
  terminalRequestFailure,
  thrownRequestStoreFailure,
  validateRequestMutation,
} from "./request-terminal-use-case";

export interface SessionRequestCancelArguments {
  readonly request_id: unknown;
}

export interface SessionRequestCancelResult {
  readonly request_id: string;
  readonly state: "cancelled";
  readonly cancelled_at_ms: number;
}

export interface SessionRequestCancelPorts {
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly clock: ClockPort;
  readonly requests: RequestTerminalPersistencePort;
  readonly notifications: CommittedRequestNotificationPort;
}

export async function cancelSessionRequest(
  ports: SessionRequestCancelPorts,
  context: SessionRequestMutationContext,
  args: SessionRequestCancelArguments,
): Promise<DomainResult<SessionRequestCancelResult>> {
  const identity = validateRequestMutation(context, args.request_id);
  if (!identity.ok) return identity;
  const current = await requireCurrentCaller(ports, context, identity.value.callerSessionId);
  if (!current.ok) return current;
  assertRequestMutationControl(ports, context);
  try {
    const stored: unknown = await ports.requests.cancelPending({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId: identity.value.requestId,
      callerSessionId: identity.value.callerSessionId,
    });
    if (
      !hasExactKeys(stored, ["ok", "outcome", "resolutionState", "request"]) ||
      stored.ok !== true
    ) {
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
        return mapAuthoritativeCancellation(
          failure.request,
          identity.value.requestId,
          ports.notifications,
        );
      }
      return malformedRequestStoreFailure();
    }
    const request = stored.request;
    if (
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
    if (!validCancellationCorrelation(stored.outcome, stored.resolutionState, request)) {
      return malformedRequestStoreFailure();
    }
    const output: DomainResult<SessionRequestCancelResult> =
      stored.outcome === "terminal_state"
        ? terminalRequestFailure(request)
        : {
            ok: true,
            value: {
              request_id: identity.value.requestId,
              state: "cancelled",
              cancelled_at_ms: request.resolvedAtMs,
            },
          };
    const event = createTerminalNotificationEvent(request);
    notifyTerminalSafely(ports.notifications, event);
    return output;
  } catch (cause: unknown) {
    return thrownRequestStoreFailure(cause);
  }
}

function mapAuthoritativeCancellation(
  request: RequestMetadata,
  requestId: RequestMetadata["id"],
  notifications: CommittedRequestNotificationPort,
): DomainResult<SessionRequestCancelResult> {
  if (request.resolutionState === "pending") {
    return requestMutationStoreFailure("state_conflict");
  }
  const output: DomainResult<SessionRequestCancelResult> =
    request.resolutionState === "cancelled"
      ? {
          ok: true,
          value: {
            request_id: requestId,
            state: "cancelled",
            cancelled_at_ms: request.resolvedAtMs,
          },
        }
      : terminalRequestFailure(request);
  const event = createTerminalNotificationEvent(request);
  notifyTerminalSafely(notifications, event);
  return output;
}

function validCancellationCorrelation(
  outcome: unknown,
  resolutionState: unknown,
  request: RequestMetadata,
): request is RequestMetadata & {
  readonly resolutionState: Exclude<RequestResolutionState, "pending">;
} {
  if (resolutionState !== request.resolutionState) return false;
  if (outcome === "applied" || outcome === "idempotent") {
    return resolutionState === "cancelled";
  }
  return (
    outcome === "terminal_state" && resolutionState !== "pending" && resolutionState !== "cancelled"
  );
}
