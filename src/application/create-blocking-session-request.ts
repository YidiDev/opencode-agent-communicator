import type { NativeMessageId, RequestId, StartOperationId } from "../domain/generated-ids";
import { OwnershipLostFault } from "../domain/ownership";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  serializeVerifiedRequestEnvelope,
} from "../domain/request-serialization";
import type { PendingRequestMetadata, RequestKind } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import { runUntilAborted } from "./abortable-operation";
import { claimAndAdmitBlockingRequest } from "./blocking-session-request-admission";
import {
  blockingCheckpoint,
  type RequestDeadlineWakePort,
  type SessionBlockingRequestContext,
  type SessionBlockingRequestPorts,
  validateBlockingInput,
  validateGeneratedRequestIds,
} from "./blocking-session-request-boundaries";
import { persistPreparedBlockingRequest } from "./blocking-session-request-creation-settlement";
import {
  type BlockingSessionRequestSuccess,
  blockUntilRequestTerminal,
  RequestRuntimeShutdownFault,
} from "./blocking-session-request-wait";
import { assertCommunicatorReady } from "./communicator-readiness-port";
import type { OperationControl } from "./delivery-ports";
import { observeNativePromiseRejection } from "./native-promise-observation";
import { inspectRequestAuthorizationDecision } from "./request-authorization-port";
import { inspectParticipantObservation } from "./request-recovery-boundaries";
import type { RequestRuntimeRegistration } from "./request-runtime";
import { snapshotDataRecord } from "./strict-port-boundaries";

export type {
  RequestDeadlineWakePort,
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
export type { BlockingSessionRequestSuccess } from "./blocking-session-request-wait";
export { RequestRuntimeShutdownFault } from "./blocking-session-request-wait";

const storageFailure = (): DomainResult<never> =>
  domainFailure("storage_unavailable", "Request storage is unavailable.", true);
const cancelledFailure = (): DomainResult<never> =>
  domainFailure("request_cancelled", "Request was cancelled.", false);

function control(context: SessionBlockingRequestContext): OperationControl {
  return {
    abort: context.abort,
    deadlineMs: context.deadlineMs,
  };
}

async function currentOwnership(
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
  if (settled.kind === "aborted") return cancelledFailure();
  if (settled.kind === "rejected") {
    return settled.cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : storageFailure();
  }
  return settled.value === true
    ? { ok: true, value: undefined }
    : domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
}

async function observeActive(
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
    if (settled.kind === "rejected" && settled.cause instanceof OwnershipLostFault) {
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    }
    return domainFailure("native_unavailable", "Current request activity is unavailable.", true);
  }
  const observed = inspectParticipantObservation(settled.value);
  if (!observed) {
    return domainFailure("native_unavailable", "Current request activity is unavailable.", true);
  }
  if (!observed.sourceVisible) {
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  }
  if (!observed.targetVisible) {
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  }
  if (observed.targetStatus === "idle") {
    return domainFailure("target_idle", "Target is idle; queue a normal message first.", false);
  }
  if (observed.targetStatus === "unknown") {
    return domainFailure("target_status_unknown", "Target activity is unknown.", true);
  }
  return { ok: true, value: true };
}

async function proveCurrentCallerVisibility(
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
  if (settlement.kind === "aborted") return cancelledFailure();
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

function wakeScheduler(port: RequestDeadlineWakePort): void {
  try {
    const returned: unknown = port.wake();
    if (returned !== undefined) observeNativePromiseRejection(returned);
  } catch {
    // The committed request is authoritative; scheduler recovery remains available.
  }
}

async function authorize(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  request: PendingRequestMetadata,
  timeoutSeconds: number,
): Promise<DomainResult<undefined>> {
  const before = await currentOwnership(ports, context);
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
  if (settled.kind === "aborted") return cancelledFailure();
  if (settled.kind === "rejected") return storageFailure();
  const decision = inspectRequestAuthorizationDecision(settled.value);
  if (!decision) return storageFailure();
  if (decision.kind === "deny")
    return domainFailure("permission_denied", "Request permission was denied.", false);
  if (decision.kind === "approval_rejected") {
    return domainFailure("approval_rejected", "Request approval was rejected.", false);
  }
  if (decision.kind !== "allow") return storageFailure();
  return currentOwnership(ports, context);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: creation ordering is intentionally linear so approval, fencing, attachment, and commit remain reviewable.
async function createInternal(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  operation: RequestKind,
  args: unknown,
): Promise<DomainResult<BlockingSessionRequestSuccess>> {
  const validated = validateBlockingInput(operation, context, args);
  if (!validated.ok) return validated;
  const digestSettlement = await runUntilAborted(context.abort, () =>
    canonicalizeSerializeAndDigestPendingRequestPayload(ports.digest, validated.value.payload),
  );
  if (digestSettlement.kind === "aborted") return cancelledFailure();
  if (digestSettlement.kind !== "settled") return storageFailure();
  if (!digestSettlement.value.ok) {
    return domainFailure("invalid_arguments", digestSettlement.value.message, false);
  }
  const visibleCaller = await proveCurrentCallerVisibility(ports, context);
  if (!visibleCaller.ok) return visibleCaller;
  const checkpoint = blockingCheckpoint(ports.clock, context);
  if (!checkpoint.ok) return checkpoint;
  let requestId: RequestId;
  let nativeMessageId: NativeMessageId;
  let creationOperationId: StartOperationId;
  try {
    requestId = ports.ids.requestId();
    nativeMessageId = ports.ids.nativeMessageId();
    creationOperationId = ports.ids.startOperationId();
  } catch {
    return storageFailure();
  }
  if (!validateGeneratedRequestIds(requestId, nativeMessageId, creationOperationId))
    return storageFailure();
  const createdAtMs = checkpoint.value;
  const timeoutMs = validated.value.payload.timeoutSeconds * 1_000;
  const deadlineAtMs = createdAtMs + timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(deadlineAtMs) ||
    deadlineAtMs <= createdAtMs
  ) {
    return domainFailure(
      "invalid_arguments",
      "Request timeout cannot form a safe deadline.",
      false,
    );
  }
  const payload = digestSettlement.value;
  const prepared: PendingRequestMetadata & { readonly deliveryState: "prepared" } = {
    id: requestId,
    workspaceKey: validated.value.workspaceKey,
    sourceSessionId: validated.value.sourceSessionId,
    targetSessionId: validated.value.targetSessionId,
    nativeMessageId,
    kind: operation,
    resolutionState: "pending",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: payload.byteLength,
    payloadSha256: payload.sha256,
    createdAtMs,
    updatedAtMs: createdAtMs,
    deadlineAtMs,
  };
  const envelopeSettlement = await runUntilAborted(context.abort, () =>
    serializeVerifiedRequestEnvelope(
      { ...prepared, requestId, payload: payload.value },
      ports.digest,
    ),
  );
  if (envelopeSettlement.kind === "aborted") return cancelledFailure();
  if (envelopeSettlement.kind !== "settled") return storageFailure();
  const approved = await authorize(ports, context, prepared, payload.value.timeoutSeconds);
  if (!approved.ok) return approved;
  // This is intentionally the sole target observation and the final active-eligibility check.
  const persistenceActivity = await observeActive(ports, context, validated.value.targetSessionId);
  if (!persistenceActivity.ok) return persistenceActivity;
  const current = await currentOwnership(ports, context);
  if (!current.ok) return current;
  let provisional: RequestRuntimeRegistration;
  try {
    provisional = ports.runtime.attachProvisional({
      requestId,
      expectedKind: operation,
      sourceSessionId: context.sourceSessionId,
      workspaceKey: context.workspaceKey,
    });
  } catch {
    return domainFailure("quota_exceeded", "Blocking request waiter capacity is exhausted.", false);
  }
  const prepareInput = {
    fencingToken: context.fencingToken,
    creationOperationId,
    request: prepared,
    payloadJson: payload.serialized,
    envelopeJson: envelopeSettlement.value,
  } as const;
  const settlement = await persistPreparedBlockingRequest(ports, context, prepareInput);
  if (!settlement.ok) {
    provisional.detach();
    return settlement;
  }
  wakeScheduler(ports.scheduler);
  const admissionController = linkedAdmissionController(context.abort, ports.runtime.effectSignal);
  const admissionStarted =
    (settlement.value.deliveryState === "prepared" ||
      settlement.value.deliveryState === "submitting") &&
    settlement.value.resolutionState === "pending"
      ? await claimAndAdmitBlockingRequest(ports, context, settlement.value, admissionController)
      : { ok: true as const, value: undefined };
  if (!admissionStarted.ok) {
    // Creation is durable. Do not abandon it because admission startup was ambiguous.
    wakeScheduler(ports.scheduler);
  }
  return blockUntilRequestTerminal(
    ports,
    context,
    prepared,
    provisional,
    payload.value,
    admissionController,
  );
}

function linkedAdmissionController(caller: AbortSignal, lifecycle: AbortSignal): AbortController {
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

type BlockingOperationResult = {
  readonly ask: Extract<BlockingSessionRequestSuccess, { readonly state: "answered" }>;
  readonly wait: Extract<BlockingSessionRequestSuccess, { readonly state: "reached" }>;
};

export function createBlockingSessionRequest(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  operation: "ask",
  args: unknown,
): Promise<DomainResult<BlockingOperationResult["ask"]>>;
export function createBlockingSessionRequest(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  operation: "wait",
  args: unknown,
): Promise<DomainResult<BlockingOperationResult["wait"]>>;
export async function createBlockingSessionRequest(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  operation: RequestKind,
  args: unknown,
): Promise<DomainResult<BlockingSessionRequestSuccess>> {
  assertCommunicatorReady(ports.readiness);
  if (!Number.isSafeInteger(context.deadlineMs) || context.deadlineMs < 0) {
    return domainFailure("invalid_arguments", "Invocation deadline is malformed.", false);
  }
  let nowMs: number;
  try {
    nowMs = ports.clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid clock");
  } catch {
    return storageFailure();
  }
  const invocation = new AbortController();
  const callerAbort = (): void => invocation.abort(context.abort.reason ?? "caller_cancelled");
  context.abort.addEventListener("abort", callerAbort, { once: true });
  if (context.abort.aborted) callerAbort();
  let deadlineTimer: { cancel(): void };
  try {
    deadlineTimer = ports.deadlineTimer.arm(Math.max(0, context.deadlineMs - nowMs), () => {
      invocation.abort("invocation_deadline");
    });
  } catch {
    context.abort.removeEventListener("abort", callerAbort);
    return storageFailure();
  }
  const invocationContext: SessionBlockingRequestContext = {
    workspaceKey: context.workspaceKey,
    sourceSessionId: context.sourceSessionId,
    fencingToken: context.fencingToken,
    abort: invocation.signal,
    deadlineMs: context.deadlineMs,
  };
  try {
    const result = await createInternal(ports, invocationContext, operation, args);
    if (!result.ok) return result;
    if (operation === "ask" && result.value.state !== "answered") return storageFailure();
    if (operation === "wait" && result.value.state !== "reached") return storageFailure();
    return result;
  } catch (cause: unknown) {
    if (cause instanceof RequestRuntimeShutdownFault) throw cause;
    return storageFailure();
  } finally {
    context.abort.removeEventListener("abort", callerAbort);
    deadlineTimer.cancel();
  }
}
