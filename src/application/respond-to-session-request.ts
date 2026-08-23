import type { Sha256DigestPort } from "../domain/message-payload";
import {
  validateRetainedAskRequestResult,
  validateRetainedRequestResult,
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

export interface SessionRespondArguments {
  readonly request_id: unknown;
  readonly answers: unknown;
}

export interface SessionRespondResult {
  readonly request_id: string;
  readonly state: "answered";
  readonly answered_at_ms: number;
}

export interface SessionRespondPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly clock: ClockPort;
  readonly digest: Sha256DigestPort;
  readonly requests: RequestTerminalPersistencePort;
  readonly notifications: CommittedRequestNotificationPort;
}

function answersEqual(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[],
): boolean {
  if (left.length !== right.length) return false;
  for (let outer = 0; outer < left.length; outer += 1) {
    const leftAnswers = left[outer];
    const rightAnswers = right[outer];
    if (!leftAnswers || !rightAnswers || leftAnswers.length !== rightAnswers.length) return false;
    for (let inner = 0; inner < leftAnswers.length; inner += 1) {
      if (leftAnswers[inner] !== rightAnswers[inner]) return false;
    }
  }
  return true;
}

export async function respondToSessionRequest(
  ports: SessionRespondPorts,
  context: SessionRequestMutationContext,
  args: SessionRespondArguments,
): Promise<DomainResult<SessionRespondResult>> {
  assertCommunicatorReady(ports.readiness);
  const identity = validateRequestMutation(context, args.request_id);
  if (!identity.ok) return identity;
  const answers = validateRetainedAskRequestResult({ kind: "ask", answers: args.answers });
  if (!answers.ok) return domainFailure("invalid_arguments", answers.message, false);
  const submitted = await prepareSubmittedRetainedResult(ports, context, answers.value);
  if (!submitted.ok) return submitted;
  const current = await requireCurrentCaller(ports, context, identity.value.callerSessionId);
  if (!current.ok) return current;
  assertRequestMutationControl(ports, context);
  try {
    const stored: unknown = await ports.requests.answerAsk({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId: identity.value.requestId,
      callerSessionId: identity.value.callerSessionId,
      answers: answers.value.answers,
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
      result.value.kind !== "ask" ||
      !answersEqual(result.value.answers, answers.value.answers)
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
      request.kind !== "ask" ||
      request.resolutionState !== "answered" ||
      request.resultState !== "available" ||
      request.resultByteLength !== submitted.value.byteLength ||
      request.resultSha256 !== submitted.value.sha256 ||
      result.byteLength !== submitted.value.byteLength
    ) {
      return malformedRequestStoreFailure();
    }
    const output: DomainResult<SessionRespondResult> = {
      ok: true,
      value: {
        request_id: identity.value.requestId,
        state: "answered",
        answered_at_ms: request.resolvedAtMs,
      },
    };
    const event = createTerminalNotificationEvent(request, result.value);
    notifyTerminalSafely(ports.notifications, event);
    return output;
  } catch (cause: unknown) {
    return thrownRequestStoreFailure(cause);
  }
}
