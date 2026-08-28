import { OwnershipLostFault } from "../domain/ownership";
import type { PendingRequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import { runUntilAborted } from "./abortable-operation";
import {
  blockingCheckpoint,
  type RequestDeadlineWakePort,
  type SessionBlockingRequestContext,
  type SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
import type { OperationControl } from "./delivery-ports";
import { observeNativePromiseRejection } from "./native-promise-observation";
import { inspectRequestAuthorizationDecision } from "./request-authorization-port";
import { inspectParticipantObservation } from "./request-recovery-boundaries";
import { snapshotDataRecord } from "./strict-port-boundaries";

export const requestStorageFailure = (): DomainResult<never> =>
  domainFailure("storage_unavailable", "Request storage is unavailable.", true);
export const requestCancelledFailure = (): DomainResult<never> =>
  domainFailure("request_cancelled", "Request was cancelled.", false);

function control(context: SessionBlockingRequestContext): OperationControl {
  return { abort: context.abort, deadlineMs: context.deadlineMs };
}

export async function currentRequestOwnership(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
): Promise<DomainResult<undefined>> {
  const before = blockingCheckpoint(ports.clock, context);
  if (!before.ok) return before;
  const settled = await runUntilAborted(context.abort, () =>
    ports.ownership.isCurrent(context.fencingToken),
  );
  const after = blockingCheckpoint(ports.clock, context);
  if (!after.ok) return after;
  if (settled.kind === "aborted") return requestCancelledFailure();
  if (settled.kind === "rejected")
    return settled.cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : requestStorageFailure();
  return settled.value === true
    ? { ok: true, value: undefined }
    : domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
}

export async function observeActiveRequestParticipants(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  target: SessionId,
): Promise<DomainResult<boolean>> {
  const before = blockingCheckpoint(ports.clock, context);
  if (!before.ok) return before;
  const settled = await runUntilAborted(context.abort, () =>
    ports.activity.observeRequestParticipants(
      context.workspaceKey,
      context.sourceSessionId,
      target,
      context.abort,
    ),
  );
  const after = blockingCheckpoint(ports.clock, context);
  if (!after.ok) return after;
  if (settled.kind !== "settled") {
    if (settled.kind === "rejected" && settled.cause instanceof OwnershipLostFault)
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    return domainFailure("native_unavailable", "Current request activity is unavailable.", true);
  }
  const observed = inspectParticipantObservation(settled.value);
  if (!observed)
    return domainFailure("native_unavailable", "Current request activity is unavailable.", true);
  if (!observed.sourceVisible)
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  if (!observed.targetVisible)
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  if (observed.targetStatus === "idle")
    return domainFailure("target_idle", "Target is idle; queue a normal message first.", false);
  if (observed.targetStatus === "unknown")
    return domainFailure("target_status_unknown", "Target activity is unknown.", true);
  return { ok: true, value: true };
}

export async function proveCurrentCallerVisibility(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
): Promise<DomainResult<undefined>> {
  const settlement = await runUntilAborted(context.abort, () =>
    ports.membership.readCurrentRoots(
      context.workspaceKey,
      context.sourceSessionId,
      context.sourceSessionId,
    ),
  );
  const checkpoint = blockingCheckpoint(ports.clock, context);
  if (!checkpoint.ok) return checkpoint;
  if (settlement.kind === "aborted") return requestCancelledFailure();
  if (settlement.kind === "rejected")
    return settlement.cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  const membership = snapshotDataRecord(settlement.value, 3);
  if (!membership || typeof membership.sourceVisible !== "boolean")
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  return membership.sourceVisible
    ? { ok: true, value: undefined }
    : domainFailure("caller_not_visible", "Caller is not a current visible root session.", false);
}

export function wakeRequestScheduler(port: RequestDeadlineWakePort): void {
  try {
    const returned: unknown = port.wake();
    if (returned !== undefined) observeNativePromiseRejection(returned);
  } catch {}
}

export async function authorizeBlockingRequest(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  request: PendingRequestMetadata,
  timeoutSeconds: number,
): Promise<DomainResult<undefined>> {
  const before = await currentRequestOwnership(ports, context);
  if (!before.ok) return before;
  const settled = await runUntilAborted(context.abort, () =>
    ports.authorization.authorizeRequest(
      {
        workspaceKey: request.workspaceKey,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.targetSessionId,
        operation: request.kind,
        payloadSha256: request.payloadSha256,
        payloadByteLength: request.payloadByteLength,
        timeoutSeconds,
        createdAtMs: request.createdAtMs,
        deadlineAtMs: request.deadlineAtMs,
      },
      control(context),
    ),
  );
  const checkpoint = blockingCheckpoint(ports.clock, context);
  if (!checkpoint.ok) return checkpoint;
  if (settled.kind === "aborted") return requestCancelledFailure();
  if (settled.kind === "rejected") return requestStorageFailure();
  const decision = inspectRequestAuthorizationDecision(settled.value);
  if (!decision) return requestStorageFailure();
  if (decision.kind === "deny")
    return domainFailure("permission_denied", "Request permission was denied.", false);
  if (decision.kind === "approval_rejected")
    return domainFailure("approval_rejected", "Request approval was rejected.", false);
  if (decision.kind !== "allow") return requestStorageFailure();
  return currentRequestOwnership(ports, context);
}

export function linkedAdmissionController(
  caller: AbortSignal,
  lifecycle: AbortSignal,
): AbortController {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  const alreadyAborted = [caller, lifecycle].find((signal) => signal.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return controller;
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      listeners.length = 0;
    },
    { once: true },
  );
  for (const signal of [caller, lifecycle]) {
    if (controller.signal.aborted) break;
    const listener = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
    if (signal.aborted) controller.abort(signal.reason);
  }
  return controller;
}
