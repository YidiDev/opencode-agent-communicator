import {
  type GeneratedIdFactory,
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../domain/generated-ids";
import type { Sha256DigestPort } from "../domain/message-payload";
import { type FencingToken, validateFencingToken } from "../domain/ownership";
import { validateAskRequestPayload, validateWaitRequestPayload } from "../domain/request-content";
import type { PendingRequestPayload } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { type SessionId, validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorReadinessPort } from "./communicator-readiness-port";
import type { ClockPort, CurrentWorkspaceMembershipPort, OwnershipPort } from "./delivery-ports";
import type { RequestAuthorizationPort } from "./request-authorization-port";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type {
  NativeSteerAdmissionPort,
  RequestAdmissionPersistencePort,
  RequestParticipantActivityPort,
  RequestParticipantQueryPort,
  RequestTerminalPersistencePort,
} from "./request-ports";
import type { RequestRuntime } from "./request-runtime";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export interface ValidatedBlockingInput {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly payload: PendingRequestPayload;
}

export interface SessionBlockingRequestContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly fencingToken: FencingToken;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
}

export interface RequestDeadlineWakePort {
  wake(): undefined;
}

export interface RequestDeadlineTimerPort {
  arm(delayMs: number, wake: () => void): { cancel(): void };
}

export interface RequestWorkflowFaultPort {
  /**
   * Forces a lifecycle out of readiness only when `fencingToken` is still that lifecycle's owned
   * token. Implementations must ignore stale tokens so delayed cleanup cannot fault a successor.
   */
  fault(input: {
    readonly fencingToken: FencingToken;
    readonly reason: "request_admission_cleanup_unresolved";
  }): void;
}

export interface SessionBlockingRequestPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly activity: RequestParticipantActivityPort;
  readonly authorization: RequestAuthorizationPort;
  readonly requests: RequestAdmissionPersistencePort &
    RequestTerminalPersistencePort &
    RequestParticipantQueryPort;
  readonly nativeSteer: NativeSteerAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly runtime: RequestRuntime;
  readonly scheduler: RequestDeadlineWakePort;
  readonly deadlineTimer: RequestDeadlineTimerPort;
  readonly workflowFault: RequestWorkflowFaultPort;
  readonly clock: ClockPort;
  readonly ids: GeneratedIdFactory;
  readonly digest: Sha256DigestPort;
}

const cancelled = (): DomainResult<never> =>
  domainFailure("request_cancelled", "Request creation was cancelled.", false);
const malformed = (): DomainResult<never> =>
  domainFailure("storage_unavailable", "A request boundary is unavailable.", true);

export function blockingCheckpoint(
  clock: ClockPort,
  context: Pick<SessionBlockingRequestContext, "abort" | "deadlineMs">,
): DomainResult<number> {
  try {
    if (context.abort.aborted) return cancelled();
    const nowMs: unknown = clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || (nowMs as number) < 0) return malformed();
    if (context.abort.aborted) return cancelled();
    if (
      context.deadlineMs !== undefined &&
      (!Number.isSafeInteger(context.deadlineMs) ||
        context.deadlineMs < 0 ||
        (nowMs as number) >= context.deadlineMs)
    ) {
      return cancelled();
    }
    return { ok: true, value: nowMs as number };
  } catch {
    return malformed();
  }
}

function copyQuestion(value: unknown): unknown {
  const question = snapshotDataRecord(value, 4);
  if (!question) return undefined;
  const keys = Object.keys(question);
  if (
    !keys.includes("prompt") ||
    !keys.includes("options") ||
    keys.some((key) => !["prompt", "options", "multiple", "allow_custom"].includes(key))
  ) {
    return undefined;
  }
  const options = snapshotDenseArray(question.options, 20);
  if (!options) return undefined;
  if (
    (Object.hasOwn(question, "multiple") && typeof question.multiple !== "boolean") ||
    (Object.hasOwn(question, "allow_custom") && typeof question.allow_custom !== "boolean")
  ) {
    return undefined;
  }
  return {
    prompt: question.prompt,
    options,
    multiple: Object.hasOwn(question, "multiple") ? question.multiple : false,
    allowCustom: Object.hasOwn(question, "allow_custom") ? question.allow_custom : false,
  };
}

function publicPayload(
  operation: "ask" | "wait",
  args: unknown,
): DomainResult<PendingRequestPayload> {
  const record = snapshotDataRecord(args, 3);
  if (!record) return domainFailure("invalid_arguments", "Arguments must be a data object.", false);
  const expected =
    operation === "ask"
      ? ["session_id", "questions", "timeout_seconds"]
      : ["session_id", "milestone", "timeout_seconds"];
  const keys = Object.keys(record);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    return domainFailure("invalid_arguments", "Request arguments have an invalid shape.", false);
  }
  if (operation === "ask") {
    const questions = snapshotDenseArray(record.questions, 10);
    if (!questions) return domainFailure("invalid_arguments", "Questions are malformed.", false);
    const copied = questions.map(copyQuestion);
    if (copied.some((question) => question === undefined)) {
      return domainFailure("invalid_arguments", "A question is malformed.", false);
    }
    const validated = validateAskRequestPayload({
      kind: "ask",
      questions: copied,
      timeoutSeconds: record.timeout_seconds,
    });
    return validated.ok
      ? { ok: true, value: validated.value }
      : domainFailure("invalid_arguments", validated.message, false);
  }
  const validated = validateWaitRequestPayload({
    kind: "wait",
    milestone: record.milestone,
    timeoutSeconds: record.timeout_seconds,
  });
  return validated.ok
    ? { ok: true, value: validated.value }
    : domainFailure("invalid_arguments", validated.message, false);
}

export function validateBlockingInput(
  operation: "ask" | "wait",
  context: SessionBlockingRequestContext,
  args: unknown,
): DomainResult<ValidatedBlockingInput> {
  const workspace = validateWorkspaceKey(context.workspaceKey);
  const source = validateSessionId(context.sourceSessionId);
  const token = validateFencingToken(context.fencingToken);
  const record = snapshotDataRecord(args, 3);
  const target = validateSessionId(record?.session_id);
  if (!workspace.ok) return domainFailure("invalid_arguments", workspace.message, false);
  if (!source.ok) return domainFailure("invalid_arguments", source.message, false);
  if (!token.ok) return domainFailure("invalid_arguments", token.message, false);
  if (!target.ok) return domainFailure("invalid_arguments", target.message, false);
  if (source.value === target.value) {
    return domainFailure("deadlock_detected", "A session cannot block on itself.", false);
  }
  const payload = publicPayload(operation, args);
  if (!payload.ok) return payload;
  return {
    ok: true,
    value: {
      workspaceKey: workspace.value,
      sourceSessionId: source.value,
      targetSessionId: target.value,
      payload: payload.value,
    },
  };
}

export function validateGeneratedRequestIds(
  requestId: unknown,
  nativeMessageId: unknown,
  creationOperationId: unknown,
): boolean {
  return (
    validateRequestId(requestId).ok &&
    validateNativeMessageId(nativeMessageId).ok &&
    validateStartOperationId(creationOperationId).ok
  );
}
