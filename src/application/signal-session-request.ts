import type { Sha256DigestPort } from "../domain/message-payload";
import {
  validateRetainedRequestResult,
  validateWaitRequestResult,
} from "../domain/request-content";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import { type DomainResult, domainFailure } from "../domain/results";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
} from "./communicator-readiness-port";
import type { ClockPort, CurrentWorkspaceMembershipPort } from "./delivery-ports";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type { RequestTerminalPersistencePort } from "./request-ports";
import { prepareSubmittedRetainedResult } from "./request-result-preparation";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import {
  assertRequestMutationControl,
  hasExactKeys,
  malformedRequestStoreFailure,
  mapTargetTerminalStoreFailure,
  requestMatchesParticipant,
  requireCurrentCaller,
  type SessionRequestMutationContext,
  thrownRequestStoreFailure,
  validateRequestMutation,
} from "./request-terminal-use-case";

export interface SessionSignalArguments {
  readonly request_id: unknown;
  readonly evidence?: unknown;
}

export interface SessionSignalResult {
  readonly request_id: string;
  readonly state: "reached";
  readonly reached_at_ms: number;
}

export interface SessionSignalPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly clock: ClockPort;
  readonly digest: Sha256DigestPort;
  readonly requests: RequestTerminalPersistencePort;
  readonly notifications: CommittedRequestNotificationPort;
}

export async function signalSessionRequest(
  ports: SessionSignalPorts,
  context: SessionRequestMutationContext,
  args: SessionSignalArguments,
): Promise<DomainResult<SessionSignalResult>> {
  assertCommunicatorReady(ports.readiness);
  const identity = validateRequestMutation(context, args.request_id);
  if (!identity.ok) return identity;
  const evidence = validateWaitRequestResult(
    args.evidence === undefined ? { kind: "wait" } : { kind: "wait", evidence: args.evidence },
  );
  if (!evidence.ok) return domainFailure("invalid_arguments", evidence.message, false);
  const submitted = await prepareSubmittedRetainedResult(ports, context, evidence.value);
  if (!submitted.ok) return submitted;
  const current = await requireCurrentCaller(ports, context, identity.value.callerSessionId);
  if (!current.ok) return current;
  assertRequestMutationControl(ports, context);
  try {
    const stored: unknown = await ports.requests.signalWait({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId: identity.value.requestId,
      callerSessionId: identity.value.callerSessionId,
      ...(evidence.value.evidence === undefined ? {} : { evidence: evidence.value.evidence }),
    });
    if (!hasExactKeys(stored, ["ok", "outcome", "request", "result"]) || stored.ok !== true) {
      return mapTargetTerminalStoreFailure(
        stored,
        {
          workspaceKey: context.workspaceKey,
          requestId: identity.value.requestId,
          callerSessionId: identity.value.callerSessionId,
        },
        ports.notifications,
      );
    }
    const result = validateRetainedRequestResult(stored.result);
    if (
      stored.outcome !== "applied" ||
      !result.ok ||
      result.value.kind !== "wait" ||
      result.value.evidence !== evidence.value.evidence
    ) {
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
        "target",
      )
    ) {
      return malformedRequestStoreFailure();
    }
    if (
      request.kind !== "wait" ||
      request.resolutionState !== "reached" ||
      request.resultState !== "available" ||
      request.resultByteLength !== submitted.value.byteLength ||
      request.resultSha256 !== submitted.value.sha256 ||
      result.byteLength !== submitted.value.byteLength
    ) {
      return malformedRequestStoreFailure();
    }
    const output: DomainResult<SessionSignalResult> = {
      ok: true,
      value: {
        request_id: identity.value.requestId,
        state: "reached",
        reached_at_ms: request.resolvedAtMs,
      },
    };
    const event = createTerminalNotificationEvent(request, result.value);
    notifyTerminalSafely(ports.notifications, event);
    return output;
  } catch (cause: unknown) {
    return thrownRequestStoreFailure(cause);
  }
}
