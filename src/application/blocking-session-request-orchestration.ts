import type { NativeMessageId, RequestId, StartOperationId } from "../domain/generated-ids";
import { blockingRequestDeadlineMarginMs } from "../domain/request-constants";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  serializeVerifiedRequestEnvelope,
} from "../domain/request-serialization";
import type { PendingRequestMetadata, RequestKind } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { runUntilAborted } from "./abortable-operation";
import {
  authorizeBlockingRequest as authorize,
  requestCancelledFailure as cancelledFailure,
  currentRequestOwnership as currentOwnership,
  linkedAdmissionController,
  observeActiveRequestParticipants as observeActive,
  proveCurrentCallerVisibility,
  requestStorageFailure as storageFailure,
  wakeRequestScheduler as wakeScheduler,
} from "./blocking-request-creation-preconditions";
import { claimAndAdmitBlockingRequest } from "./blocking-session-request-admission";
import {
  blockingCheckpoint,
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
import type { RequestRuntimeRegistration } from "./request-runtime";

export type {
  RequestDeadlineWakePort,
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
export type { BlockingSessionRequestSuccess } from "./blocking-session-request-wait";
export { RequestRuntimeShutdownFault } from "./blocking-session-request-wait";

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
  const settlementBoundaryMs = deadlineAtMs + blockingRequestDeadlineMarginMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(deadlineAtMs) ||
    deadlineAtMs <= createdAtMs ||
    !Number.isSafeInteger(settlementBoundaryMs)
  ) {
    return domainFailure(
      "invalid_arguments",
      "Request timeout cannot form a safe deadline.",
      false,
    );
  }
  // Never persist a request whose own deadline could be pre-empted by the internal invocation.
  // The reserved tail bounds the authoritative terminal read and cancellation/cleanup I/O.
  if (settlementBoundaryMs >= context.deadlineMs) {
    return domainFailure(
      "deadline_expired",
      "The invocation cannot retain the durable request deadline settlement margin.",
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
    deliveryMode: "steer",
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
    deliveryMode: "steer",
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
  assertCommunicatorReady(ports.readiness, context.fencingToken);
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
