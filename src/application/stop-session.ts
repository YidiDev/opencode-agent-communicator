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
  ParticipantOperationAbortedFault,
  ParticipantOperationGateClosedFault,
} from "./participant-operation-gate";
import {
  ParticipantStopTerminalizationFault,
  terminalizeStoppedParticipant,
} from "./participant-stop-terminalization";
import {
  applyNativeStop,
  communicatorStopState,
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
    return await stopSessionWithinDeadline(ports, linkedContext, context.abort, args);
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
  approvalAbort: AbortSignal,
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
        abort: approvalAbort,
        ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
      },
    ),
  );
  if (approval !== "approved") {
    return domainFailure("permission_denied", "Session stop is denied by policy.", false);
  }
  return applyApprovedStop(ports, context, target.value);
}

async function applyApprovedStop(
  ports: SessionStopPorts,
  context: SessionStopContext,
  targetSessionId: import("../domain/sessions").SessionId,
): Promise<DomainResult<SessionStopResult>> {
  try {
    return await ports.participantOperations.run([targetSessionId], context.abort, async () => {
      const fencingToken = communicatorLifecycleFencingToken(ports.readiness);
      // Approval is only a candidate capability. Revalidate visibility, ownership and time at
      // the last possible point before the first durable effect.
      const current = await observeStopParticipants(ports, context, targetSessionId);
      const currentVisibility = current.ok ? stopVisibilityFailure(current.value) : current;
      if (!current.ok) return current;
      if (currentVisibility) return currentVisibility;
      if (!(await stopExternal(context, () => ports.ownership.isCurrent(fencingToken)))) {
        stopCommunicatorForOwnershipLoss(ports.readiness);
        return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
      }
      const stopped = await stopExternal(context, () =>
        terminalizeStoppedParticipant({
          scope: "all",
          requests: ports.requests,
          notifications: ports.notifications,
          fencingToken,
          workspaceKey: context.workspaceKey,
          stoppedSessionId: targetSessionId,
        }),
      );
      return applyNativeStop(
        ports,
        context,
        targetSessionId,
        fencingToken,
        communicatorStopState(stopped),
      );
    });
  } catch (cause: unknown) {
    if (cause instanceof ParticipantOperationAbortedFault) throw new StopDeadlineFault();
    if (cause instanceof ParticipantOperationGateClosedFault) {
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
    if (cause instanceof ParticipantStopTerminalizationFault) {
      if (cause.code === "ownership_lost") stopCommunicatorForOwnershipLoss(ports.readiness);
      return cause.code === "ownership_lost"
        ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
        : domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
    if (cause instanceof OwnershipLostFault) stopCommunicatorForOwnershipLoss(ports.readiness);
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
}
