import type { Sha256DigestPort } from "../domain/message-payload";
import { OwnershipLostFault } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { pendingRequestsPerWorkspaceHardCeiling } from "../domain/safety-ceilings";
import { digestSessionStopReason, validateSessionStopReason } from "../domain/session-stop";
import { type SessionId, validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { boundedExternalCall } from "./bounded-external-call";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
  communicatorLifecycleFencingToken,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type { OwnershipPort } from "./delivery-ports";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type {
  RequestParticipantActivityObservation,
  RequestParticipantActivityPort,
} from "./request-ports";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import type {
  NativeSessionInterruptPort,
  SessionStopApprovalPort,
  SessionStopPersistencePort,
} from "./session-stop-ports";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export interface SessionStopArguments {
  readonly session_id: unknown;
  readonly reason?: unknown;
}

export interface SessionStopContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly abort: AbortSignal;
  readonly deadlineMs?: number;
}

export interface SessionStopPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly activity: RequestParticipantActivityPort;
  readonly approval: SessionStopApprovalPort;
  readonly requests: SessionStopPersistencePort;
  readonly nativeInterrupt: NativeSessionInterruptPort;
  readonly ownership: OwnershipPort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly digest: Sha256DigestPort;
}

export interface SessionStopResult {
  readonly sessionId: SessionId;
  readonly communicatorState: {
    readonly outcome: "applied";
    readonly requestsTerminalized: number;
    readonly targetStopped: number;
    readonly sourceStopped: number;
  };
  readonly nativeOutcome: "already_idle" | "interrupted";
}

class StopDeadlineFault extends Error {}

async function external<Value>(
  context: SessionStopContext,
  operation: () => Promise<Value> | Value,
): Promise<Value> {
  const deadlineMs = context.deadlineMs ?? Date.now() + 3_600_000;
  const result = await boundedExternalCall(operation, context.abort, deadlineMs);
  if (result.kind === "expired") throw new StopDeadlineFault();
  if (result.kind === "rejected") throw result.cause;
  if (context.abort.aborted || Date.now() >= deadlineMs) throw new StopDeadlineFault();
  return result.value;
}

async function observe(
  ports: SessionStopPorts,
  context: SessionStopContext,
  target: SessionId,
): Promise<DomainResult<RequestParticipantActivityObservation>> {
  try {
    const raw: unknown = await external(context, () =>
      ports.activity.observeRequestParticipants(
        context.workspaceKey,
        context.sourceSessionId,
        target,
        context.abort,
      ),
    );
    const value = snapshotDataRecord(raw, 3);
    const targetStatus =
      value?.targetStatus === "busy" ||
      value?.targetStatus === "retry" ||
      value?.targetStatus === "idle" ||
      value?.targetStatus === "unknown"
        ? value.targetStatus
        : undefined;
    if (
      !value ||
      Object.keys(value).length !== 3 ||
      typeof value.sourceVisible !== "boolean" ||
      typeof value.targetVisible !== "boolean" ||
      targetStatus === undefined
    ) {
      return domainFailure("native_unavailable", "Current session state is unavailable.", true);
    }
    return {
      ok: true,
      value: {
        sourceVisible: value.sourceVisible,
        targetVisible: value.targetVisible,
        targetStatus,
      },
    };
  } catch (cause: unknown) {
    if (cause instanceof StopDeadlineFault) throw cause;
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : domainFailure("native_unavailable", "Current session state is unavailable.", true);
  }
}

function visibility(
  observation: RequestParticipantActivityObservation,
): DomainResult<never> | undefined {
  if (!observation.sourceVisible) {
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  }
  if (!observation.targetVisible) {
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  }
  return undefined;
}

function communicatorState(
  requests: readonly import("../domain/request-types").RequestMetadata[],
): SessionStopResult["communicatorState"] {
  let targetStopped = 0;
  let sourceStopped = 0;
  for (const request of requests) {
    if (request.resolutionState === "target_stopped") targetStopped += 1;
    else if (request.resolutionState === "source_stopped") sourceStopped += 1;
    else throw new TypeError("Stop persistence returned a non-stop terminal state.");
  }
  return Object.freeze({
    outcome: "applied",
    requestsTerminalized: requests.length,
    targetStopped,
    sourceStopped,
  });
}

function stoppedRequests(
  raw: unknown,
  workspaceKey: WorkspaceKey,
  stoppedSessionId: SessionId,
): DomainResult<readonly RequestMetadata[]> {
  const result = snapshotDataRecord(raw, 2);
  if (!result || typeof result.ok !== "boolean") {
    return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
  if (!result.ok) {
    const code = result.code;
    if (
      Object.keys(result).length !== 2 ||
      (code !== "ownership_lost" && code !== "storage_unavailable")
    ) {
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
    return domainFailure(
      code,
      code === "ownership_lost"
        ? "Coordinator ownership was lost."
        : "Request storage is unavailable.",
      code === "storage_unavailable",
    );
  }
  if (Object.keys(result).length !== 2) {
    return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
  const terminalized = snapshotDenseArray(
    result.terminalized,
    pendingRequestsPerWorkspaceHardCeiling,
  );
  if (!terminalized) {
    return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
  const ids = new Set<string>();
  const validated: RequestMetadata[] = [];
  for (const request of terminalized) {
    if (
      !isCoherentRequestMetadata(request) ||
      request.workspaceKey !== workspaceKey ||
      ids.has(request.id) ||
      (request.sourceSessionId !== stoppedSessionId &&
        request.targetSessionId !== stoppedSessionId) ||
      request.resolutionState !==
        (request.targetSessionId === stoppedSessionId ? "target_stopped" : "source_stopped")
    ) {
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
    ids.add(request.id);
    validated.push(request);
  }
  return { ok: true, value: Object.freeze(validated) };
}

function unknownNativeOutcome(state: SessionStopResult["communicatorState"]): DomainResult<never> {
  return domainFailure(
    "native_outcome_unknown",
    "Communicator state was applied, but native interruption could not be confirmed.",
    false,
    {
      communicator_state: {
        outcome: state.outcome,
        requests_terminalized: state.requestsTerminalized,
        target_stopped: state.targetStopped,
        source_stopped: state.sourceStopped,
      },
    },
  );
}

async function applyNativeStop(
  ports: SessionStopPorts,
  context: SessionStopContext,
  target: SessionId,
  fencingToken: import("../domain/ownership").FencingToken,
  state: SessionStopResult["communicatorState"],
): Promise<DomainResult<SessionStopResult>> {
  const success = (
    nativeOutcome: SessionStopResult["nativeOutcome"],
  ): DomainResult<SessionStopResult> => ({
    ok: true,
    value: { sessionId: target, communicatorState: state, nativeOutcome },
  });
  try {
    const current = await observe(ports, context, target);
    if (!current.ok || visibility(current.value)) return unknownNativeOutcome(state);
    if (current.value.targetStatus === "idle") return success("already_idle");
    if (current.value.targetStatus === "unknown") return unknownNativeOutcome(state);
    if (!(await external(context, () => ports.ownership.isCurrent(fencingToken))))
      return unknownNativeOutcome(state);
    const native = await external(context, () =>
      ports.nativeInterrupt.interruptSession({
        targetSessionId: target,
        abort: context.abort,
      }),
    );
    if (
      native !== "interrupted" ||
      !(await external(context, () => ports.ownership.isCurrent(fencingToken)))
    ) {
      return unknownNativeOutcome(state);
    }
    return success("interrupted");
  } catch {
    // Durable request terminalization has already committed. Deadline, caller abort and
    // transport failure can no longer be reported as if the entire stop had merely expired.
    return unknownNativeOutcome(state);
  }
}

export async function stopSession(
  ports: SessionStopPorts,
  context: SessionStopContext,
  args: SessionStopArguments,
): Promise<DomainResult<SessionStopResult>> {
  const deadlineMs = context.deadlineMs ?? Date.now() + 3_600_000;
  if (context.abort.aborted || Date.now() >= deadlineMs) {
    return domainFailure("deadline_expired", "The session stop deadline expired.", false);
  }
  const operationAbort = new AbortController();
  const relay = (): void => operationAbort.abort(context.abort.reason ?? "stop_aborted");
  context.abort.addEventListener("abort", relay, { once: true });
  const timer =
    context.deadlineMs === undefined
      ? undefined
      : setTimeout(
          () => operationAbort.abort("stop_deadline_expired"),
          Math.max(1, context.deadlineMs - Date.now()),
        );
  const linkedContext: SessionStopContext = {
    ...context,
    abort: operationAbort.signal,
    deadlineMs,
  };
  try {
    return await stopSessionWithinDeadline(ports, linkedContext, args);
  } catch (cause: unknown) {
    if (cause instanceof StopDeadlineFault) {
      return domainFailure("deadline_expired", "The session stop deadline expired.", false);
    }
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    context.abort.removeEventListener("abort", relay);
    operationAbort.abort("stop_complete");
  }
}

async function stopSessionWithinDeadline(
  ports: SessionStopPorts,
  context: SessionStopContext,
  args: SessionStopArguments,
): Promise<DomainResult<SessionStopResult>> {
  assertCommunicatorReady(ports.readiness);
  const target = validateSessionId(args.session_id);
  if (!target.ok) return domainFailure("invalid_arguments", target.message, false);
  const reason = validateSessionStopReason(args.reason);
  if (!reason.ok) return domainFailure("invalid_arguments", reason.message, false);
  const first = await observe(ports, context, target.value);
  if (!first.ok) return first;
  const firstVisibility = visibility(first.value);
  if (firstVisibility) return firstVisibility;
  if (first.value.targetStatus === "unknown") {
    return domainFailure("native_unavailable", "Target activity could not be established.", true);
  }
  const reasonSha256 = await external(context, () => digestSessionStopReason(ports.digest, reason));
  const approval = await external(context, () =>
    ports.approval.requestStopApproval(
      {
        workspaceKey: context.workspaceKey,
        sourceSessionId: context.sourceSessionId,
        targetSessionId: target.value,
        reasonSha256,
      },
      {
        abort: context.abort,
        ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
      },
    ),
  );
  if (approval !== "approved") {
    return domainFailure("approval_rejected", "Session stop approval was rejected.", false);
  }
  let fencingToken: import("../domain/ownership").FencingToken;
  let rawStopped: unknown;
  try {
    fencingToken = communicatorLifecycleFencingToken(ports.readiness);
    // Approval is only a candidate capability. Revalidate visibility, ownership and time at
    // the last possible point before the first durable effect.
    const current = await observe(ports, context, target.value);
    const currentVisibility = current.ok ? visibility(current.value) : current;
    if (!current.ok) return current;
    if (currentVisibility) return currentVisibility;
    if (!(await external(context, () => ports.ownership.isCurrent(fencingToken)))) {
      stopCommunicatorForOwnershipLoss(ports.readiness);
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    }
    rawStopped = await external(context, () =>
      ports.requests.stopPendingRequests({
        fencingToken,
        workspaceKey: context.workspaceKey,
        stoppedSessionId: target.value,
      }),
    );
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) stopCommunicatorForOwnershipLoss(ports.readiness);
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
  const stopped = stoppedRequests(rawStopped, context.workspaceKey, target.value);
  if (!stopped.ok) return stopped;
  const state = communicatorState(stopped.value);
  for (const request of stopped.value) {
    if (request.resolutionState === "pending")
      throw new TypeError("Uncommitted stop notification.");
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(request));
  }
  return applyNativeStop(ports, context, target.value, fencingToken, state);
}
