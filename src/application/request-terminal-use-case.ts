import type { RequestId } from "../domain/generated-ids";
import { validateRequestId } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorReadinessPort } from "./communicator-readiness-port";
import type { ClockPort, CurrentWorkspaceMembershipPort } from "./delivery-ports";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import { type RequestStoreFailureCode, requestStoreFailureCodes } from "./request-ports";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";

export type RequestMutationStopReason =
  | "aborted"
  | "deadline_exceeded"
  | "invalid_clock"
  | "invalid_deadline";

export class RequestMutationControlFault extends Error {
  override readonly name = "RequestMutationControlFault";

  constructor(readonly reason: RequestMutationStopReason) {
    super(
      reason === "aborted"
        ? "Request operation was aborted before persistence dispatch."
        : reason === "deadline_exceeded"
          ? "Request operation deadline elapsed before persistence dispatch."
          : reason === "invalid_clock"
            ? "Request operation clock is invalid."
            : "Request operation deadline is invalid.",
    );
  }
}

export interface SessionRequestMutationContext {
  readonly workspaceKey: WorkspaceKey;
  readonly callerSessionId: unknown;
  readonly fencingToken: FencingToken;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
}

export interface RequestMutationControlPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly clock: ClockPort;
}

export interface ValidatedRequestMutation {
  readonly callerSessionId: SessionId;
  readonly requestId: RequestId;
}

export type ParsedTerminalFailure =
  | { readonly kind: "hidden" }
  | { readonly kind: "store"; readonly code: RequestStoreFailureCode }
  | { readonly kind: "authoritative"; readonly request: RequestMetadata }
  | { readonly kind: "malformed" };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && exactKeys(value, expected);
}

export function validateRequestMutation(
  context: SessionRequestMutationContext,
  request_id: unknown,
): DomainResult<ValidatedRequestMutation> {
  const caller = validateSessionId(context.callerSessionId);
  if (!caller.ok) return domainFailure("invalid_arguments", caller.message, false);
  const request = validateRequestId(request_id);
  if (!request.ok) return domainFailure("invalid_arguments", request.message, false);
  return { ok: true, value: { callerSessionId: caller.value, requestId: request.value } };
}

export function assertRequestMutationControl(
  ports: Pick<RequestMutationControlPorts, "clock">,
  context: Pick<SessionRequestMutationContext, "abort" | "deadlineMs">,
): void {
  if (!Number.isSafeInteger(context.deadlineMs) || context.deadlineMs < 0) {
    throw new RequestMutationControlFault("invalid_deadline");
  }
  if (context.abort.aborted) throw new RequestMutationControlFault("aborted");
  let nowMs: number;
  try {
    nowMs = ports.clock.nowMs();
  } catch {
    throw new RequestMutationControlFault("invalid_clock");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RequestMutationControlFault("invalid_clock");
  }
  if (context.abort.aborted) throw new RequestMutationControlFault("aborted");
  if (nowMs >= context.deadlineMs) {
    throw new RequestMutationControlFault("deadline_exceeded");
  }
}

export async function requireCurrentCaller(
  ports: RequestMutationControlPorts,
  context: SessionRequestMutationContext,
  callerSessionId: SessionId,
): Promise<DomainResult<undefined>> {
  assertRequestMutationControl(ports, context);
  let current: unknown;
  try {
    current = await ports.membership.readCurrentRoots(
      context.workspaceKey,
      callerSessionId,
      callerSessionId,
    );
  } catch (cause: unknown) {
    assertRequestMutationControl(ports, context);
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  assertRequestMutationControl(ports, context);
  let sourceVisible: boolean | undefined;
  try {
    if (
      !isRecord(current) ||
      !exactKeys(current, ["sourceTitle", "sourceVisible", "targetVisible"]) ||
      (current.sourceTitle !== undefined && typeof current.sourceTitle !== "string") ||
      typeof current.sourceVisible !== "boolean" ||
      typeof current.targetVisible !== "boolean"
    ) {
      sourceVisible = undefined;
    } else {
      sourceVisible = current.sourceVisible;
    }
  } catch {
    sourceVisible = undefined;
  }
  assertRequestMutationControl(ports, context);
  if (sourceVisible === undefined) {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  return sourceVisible
    ? { ok: true, value: undefined }
    : domainFailure("caller_not_visible", "Caller is not a current visible root session.", false);
}

export function parseTerminalFailure(value: unknown): ParsedTerminalFailure {
  if (!isRecord(value) || value.ok !== false || typeof value.code !== "string") {
    return { kind: "malformed" };
  }
  if (value.code === "state_conflict") {
    if (exactKeys(value, ["ok", "code"])) return { kind: "store", code: "state_conflict" };
    if (exactKeys(value, ["ok", "code", "request"]) && isCoherentRequestMetadata(value.request)) {
      return { kind: "authoritative", request: value.request };
    }
    return { kind: "malformed" };
  }
  if (!exactKeys(value, ["ok", "code"])) return { kind: "malformed" };
  if (value.code === "not_found_or_unauthorized") return { kind: "hidden" };
  return requestStoreFailureCodes.includes(value.code as RequestStoreFailureCode)
    ? { kind: "store", code: value.code as RequestStoreFailureCode }
    : { kind: "malformed" };
}

export function mapTargetTerminalStoreFailure(
  value: unknown,
  binding: {
    readonly workspaceKey: WorkspaceKey;
    readonly requestId: RequestId;
    readonly callerSessionId: SessionId;
  },
  notifications: CommittedRequestNotificationPort,
): DomainResult<never> {
  const failure = parseTerminalFailure(value);
  if (failure.kind === "hidden") return hiddenRequestFailure();
  if (failure.kind === "store") return requestMutationStoreFailure(failure.code);
  if (failure.kind === "malformed") return malformedRequestStoreFailure();
  if (
    !requestMatchesParticipant(
      failure.request,
      binding.workspaceKey,
      binding.requestId,
      binding.callerSessionId,
      "target",
    )
  ) {
    return malformedRequestStoreFailure();
  }
  const output = terminalRequestFailure(failure.request);
  if (failure.request.resolutionState !== "pending") {
    const event = createTerminalNotificationEvent(failure.request);
    notifyTerminalSafely(notifications, event);
  }
  return output;
}

export function requestMutationStoreFailure(code: RequestStoreFailureCode): DomainResult<never> {
  switch (code) {
    case "quota_exceeded":
      return domainFailure("quota_exceeded", "Request result quota is exhausted.", false);
    case "rate_limited":
      return domainFailure("rate_limited", "Request mutation rate is limited.", true);
    case "ownership_lost":
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    case "state_conflict":
      return domainFailure("state_conflict", "Request state does not allow this operation.", false);
    case "storage_unavailable":
    case "deadlock_detected":
      return malformedRequestStoreFailure();
  }
}

export function malformedRequestStoreFailure(): DomainResult<never> {
  return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
}

export function hiddenRequestFailure(): DomainResult<never> {
  return domainFailure(
    "not_found_or_unauthorized",
    "Request was not found or the caller is not authorized.",
    false,
  );
}

export function terminalRequestFailure(request: RequestMetadata): DomainResult<never> {
  const state = request.resolutionState;
  if (state === "pending") {
    return domainFailure("state_conflict", "Request kind does not allow this operation.", false);
  }
  if (state === "answered" || state === "reached") {
    return domainFailure("request_not_pending", "Request is already resolved.", false, {
      terminal_state: state,
    });
  }
  const messages = {
    cancelled: "Request was cancelled.",
    deadline_expired: "Request deadline expired.",
    delivery_failed: "Request delivery failed.",
    target_stopped: "Request target was stopped.",
    source_stopped: "Request source was stopped.",
    target_deleted: "Request target was deleted.",
    source_deleted: "Request source was deleted.",
  } as const;
  const code = state === "cancelled" ? "request_cancelled" : state;
  return domainFailure(code, messages[state], false);
}

export function requestMatchesParticipant(
  request: RequestMetadata,
  workspaceKey: WorkspaceKey,
  requestId: RequestId,
  callerSessionId: SessionId,
  role: "source" | "target",
): boolean {
  return (
    request.workspaceKey === workspaceKey &&
    request.id === requestId &&
    (role === "source"
      ? request.sourceSessionId === callerSessionId
      : request.targetSessionId === callerSessionId)
  );
}

export function thrownRequestStoreFailure(cause: unknown): DomainResult<never> {
  return cause instanceof OwnershipLostFault
    ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
    : malformedRequestStoreFailure();
}
