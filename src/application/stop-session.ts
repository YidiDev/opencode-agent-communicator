import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { digestSessionStopReason, validateSessionStopReason } from "../domain/session-stop";
import { validateSessionId } from "../domain/sessions";
import {
  assertCommunicatorReady,
  communicatorLifecycleFencingToken,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import {
  applyNativeStop,
  communicatorStopState,
  inspectStoppedRequests,
  observeStopParticipants,
  StopDeadlineFault,
  stopExternal,
  stopVisibilityFailure,
} from "./stop-session-operations";
import type {
  SessionStopArguments,
  SessionStopContext,
  SessionStopPorts,
  SessionStopResult,
} from "./stop-session-types";

export type {
  SessionStopArguments,
  SessionStopContext,
  SessionStopPorts,
  SessionStopResult,
} from "./stop-session-types";

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
  const first = await observeStopParticipants(ports, context, target.value);
  if (!first.ok) return first;
  const firstVisibility = stopVisibilityFailure(first.value);
  if (firstVisibility) return firstVisibility;
  if (first.value.targetStatus === "unknown") {
    return domainFailure("native_unavailable", "Target activity could not be established.", true);
  }
  const reasonSha256 = await stopExternal(context, () =>
    digestSessionStopReason(ports.digest, reason),
  );
  const approval = await stopExternal(context, () =>
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
    const current = await observeStopParticipants(ports, context, target.value);
    const currentVisibility = current.ok ? stopVisibilityFailure(current.value) : current;
    if (!current.ok) return current;
    if (currentVisibility) return currentVisibility;
    if (!(await stopExternal(context, () => ports.ownership.isCurrent(fencingToken)))) {
      stopCommunicatorForOwnershipLoss(ports.readiness);
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    }
    rawStopped = await stopExternal(context, () =>
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
  const stopped = inspectStoppedRequests(rawStopped, context.workspaceKey, target.value);
  if (!stopped.ok) return stopped;
  const state = communicatorStopState(stopped.value);
  for (const request of stopped.value) {
    if (request.resolutionState === "pending")
      throw new TypeError("Uncommitted stop notification.");
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(request));
  }
  return applyNativeStop(ports, context, target.value, fencingToken, state);
}
