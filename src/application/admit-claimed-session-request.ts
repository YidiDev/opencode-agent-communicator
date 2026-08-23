import { type FencingToken, OwnershipLostFault, validateFencingToken } from "../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../domain/request-identity";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import type { ClockPort, OperationControl, OwnershipPort } from "./delivery-ports";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import {
  type NativeSteerAdmission,
  type NativeSteerAdmissionPort,
  type RequestAdmissionPersistencePort,
  type RequestStoreFailureCode,
  requestStoreFailureCodes,
} from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { operationControlStopped } from "./safe-clock";

export interface ClaimedSessionRequestAdmissionPorts {
  readonly requests: RequestAdmissionPersistencePort;
  readonly nativeSteer: NativeSteerAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly clock: ClockPort;
}

export type ClaimedSessionRequestAdmissionOutcome = Readonly<{
  readonly outcome: "delivery_unknown" | "delivery_failed" | "admitted" | "promoted";
  readonly request: RequestMetadata;
}>;

export interface ClaimedSessionRequestAdmissionInput {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: FencingToken;
  readonly request: RequestMetadata & { readonly deliveryState: "submitting" };
  readonly envelope: string;
  readonly control: OperationControl;
  /** Process-lifecycle signal for the external effect; it is never a request cancellation. */
  readonly effectSignal: AbortSignal;
}

function failure(code: RequestStoreFailureCode): DomainResult<never> {
  if (code === "ownership_lost") {
    return domainFailure(code, "Coordinator ownership was lost.", false);
  }
  if (code === "state_conflict") {
    return domainFailure(code, "Request state changed concurrently.", false);
  }
  return domainFailure(code, "Request persistence is unavailable.", code === "storage_unavailable");
}

function isStoreFailureCode(value: unknown): value is RequestStoreFailureCode {
  return typeof value === "string" && requestStoreFailureCodes.some((code) => code === value);
}

function stopped(ports: ClaimedSessionRequestAdmissionPorts, control: OperationControl): boolean {
  return operationControlStopped(ports.clock, control.abort, control.deadlineMs);
}

function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return undefined;
  }
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    !keys.every((key) => own.includes(key))
  ) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function inspectNative(value: unknown): NativeSteerAdmission {
  const base = dataRecord(value, ["kind"]);
  if (base && (base.kind === "unknown" || base.kind === "definitive_rejection")) {
    return { kind: base.kind };
  }
  const admitted = dataRecord(value, ["kind", "admittedSeq", "observedAtMs"]);
  if (
    admitted?.kind === "admitted" &&
    Number.isSafeInteger(admitted.admittedSeq) &&
    (admitted.admittedSeq as number) >= 0 &&
    Number.isSafeInteger(admitted.observedAtMs) &&
    (admitted.observedAtMs as number) >= 0
  ) {
    return {
      kind: "admitted",
      admittedSeq: admitted.admittedSeq as number,
      observedAtMs: admitted.observedAtMs as number,
    };
  }
  const promoted = dataRecord(value, ["kind", "admittedSeq", "promotedSeq", "observedAtMs"]);
  if (
    promoted?.kind === "promoted" &&
    Number.isSafeInteger(promoted.admittedSeq) &&
    (promoted.admittedSeq as number) >= 0 &&
    Number.isSafeInteger(promoted.promotedSeq) &&
    (promoted.promotedSeq as number) > (promoted.admittedSeq as number) &&
    Number.isSafeInteger(promoted.observedAtMs) &&
    (promoted.observedAtMs as number) >= 0
  ) {
    return {
      kind: "promoted",
      admittedSeq: promoted.admittedSeq as number,
      promotedSeq: promoted.promotedSeq as number,
      observedAtMs: promoted.observedAtMs as number,
    };
  }
  return { kind: "unknown" };
}

function linkedEffectSignal(
  first: AbortSignal,
  second: AbortSignal,
): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  for (const signal of [first, second]) {
    if (signal.aborted) controller.abort("interrupted");
    else {
      const listener = (): void => controller.abort("interrupted");
      signal.addEventListener("abort", listener, { once: true });
      listeners.push([signal, listener]);
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

function expectedCommitted(
  native: NativeSteerAdmission,
  request: RequestMetadata,
): request is RequestMetadata {
  if (native.kind === "unknown") return request.deliveryState === "delivery_unknown";
  if (native.kind === "definitive_rejection") {
    return request.deliveryState === "delivery_failed";
  }
  if (request.deliveryState !== native.kind || !request.admissionEvidence) return false;
  const evidence = request.admissionEvidence;
  return (
    evidence.state === native.kind &&
    evidence.nativeMessageId === request.nativeMessageId &&
    evidence.admittedSeq === native.admittedSeq &&
    evidence.observedAtMs === native.observedAtMs &&
    (native.kind === "admitted" ||
      (evidence.state === "promoted" && evidence.promotedSeq === native.promotedSeq))
  );
}

function completionInput(
  input: ClaimedSessionRequestAdmissionInput,
  native: NativeSteerAdmission,
): Parameters<RequestAdmissionPersistencePort["completeDelivery"]>[0] {
  const base = {
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    requestId: input.request.id,
  };
  if (native.kind === "unknown") return { ...base, outcome: "delivery_unknown" };
  if (native.kind === "definitive_rejection") return { ...base, outcome: "delivery_failed" };
  if (native.kind === "admitted") {
    return {
      ...base,
      outcome: "admitted",
      nativeMessageId: input.request.nativeMessageId,
      admittedSeq: native.admittedSeq,
      evidenceObservedAtMs: native.observedAtMs,
    };
  }
  return {
    ...base,
    outcome: "promoted",
    nativeMessageId: input.request.nativeMessageId,
    admittedSeq: native.admittedSeq,
    promotedSeq: native.promotedSeq,
    evidenceObservedAtMs: native.observedAtMs,
  };
}

function validAdmissionInput(input: ClaimedSessionRequestAdmissionInput): boolean {
  return (
    validateWorkspaceKey(input.workspaceKey).ok &&
    validateFencingToken(input.fencingToken).ok &&
    isCoherentRequestMetadata(input.request) &&
    input.request.workspaceKey === input.workspaceKey &&
    input.request.deliveryState === "submitting" &&
    typeof input.envelope === "string" &&
    input.envelope.length > 0 &&
    typeof input.control.abort === "object" &&
    input.control.abort !== null &&
    typeof input.control.abort.aborted === "boolean" &&
    typeof input.effectSignal === "object" &&
    input.effectSignal !== null &&
    typeof input.effectSignal.aborted === "boolean" &&
    (input.control.deadlineMs === undefined ||
      (Number.isSafeInteger(input.control.deadlineMs) && input.control.deadlineMs >= 0))
  );
}

async function performNativeSteer(
  ports: ClaimedSessionRequestAdmissionPorts,
  input: ClaimedSessionRequestAdmissionInput,
  signal: AbortSignal,
): Promise<NativeSteerAdmission | undefined> {
  if (signal.aborted) return undefined;
  try {
    const settlement = await runUntilAborted(signal, () =>
      ports.nativeSteer.steerRequest({
        targetSessionId: input.request.targetSessionId,
        nativeMessageId: input.request.nativeMessageId,
        envelope: input.envelope,
        abort: signal,
      }),
    );
    if (settlement.kind === "aborted") return undefined;
    if (settlement.kind === "rejected" && settlement.cause instanceof OwnershipLostFault) {
      return undefined;
    }
    return settlement.kind === "settled" ? inspectNative(settlement.value) : { kind: "unknown" };
  } catch {
    return signal.aborted ? undefined : { kind: "unknown" };
  }
}

function publicAdmissionOutcome(
  native: NativeSteerAdmission,
): ClaimedSessionRequestAdmissionOutcome["outcome"] {
  if (native.kind === "unknown") return "delivery_unknown";
  if (native.kind === "definitive_rejection") return "delivery_failed";
  return native.kind;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear admission boundary keeps interruption, fencing, effect, and exact committed-state checks auditable.
async function admitClaimedSessionRequestInternal(
  ports: ClaimedSessionRequestAdmissionPorts,
  input: ClaimedSessionRequestAdmissionInput,
): Promise<DomainResult<ClaimedSessionRequestAdmissionOutcome>> {
  if (!validAdmissionInput(input)) {
    return domainFailure("state_conflict", "Claimed request admission input is malformed.", false);
  }
  if (stopped(ports, input.control) || input.effectSignal.aborted) return failure("ownership_lost");
  const current = await runUntilAborted(input.effectSignal, () =>
    ports.ownership.isCurrent(input.fencingToken),
  );
  if (current.kind === "aborted") return failure("ownership_lost");
  if (current.kind === "rejected") {
    return failure(
      current.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
  if (current.value !== true) return failure("ownership_lost");
  // No awaited work may occur between this final startup-control check and the single native effect.
  if (stopped(ports, input.control) || input.effectSignal.aborted) return failure("ownership_lost");
  const linked = linkedEffectSignal(input.control.abort, input.effectSignal);
  let native: NativeSteerAdmission | undefined;
  try {
    native = await performNativeSteer(ports, input, linked.signal);
  } finally {
    linked.dispose();
  }
  if (!native) return failure("ownership_lost");
  // An interrupted effect is ambiguous. Keep submitting for a successor; never persist rejection.
  if (stopped(ports, input.control) || input.effectSignal.aborted) return failure("ownership_lost");
  const currentAfterEffect = await runUntilAborted(input.effectSignal, () =>
    ports.ownership.isCurrent(input.fencingToken),
  );
  if (currentAfterEffect.kind === "aborted") {
    return failure("ownership_lost");
  }
  if (currentAfterEffect.kind === "rejected") {
    return failure(
      currentAfterEffect.cause instanceof OwnershipLostFault
        ? "ownership_lost"
        : "storage_unavailable",
    );
  }
  if (currentAfterEffect.value !== true) return failure("ownership_lost");
  let raw: unknown;
  try {
    const settlement = await runUntilAborted(input.effectSignal, () =>
      ports.requests.completeDelivery(completionInput(input, native)),
    );
    if (settlement.kind === "aborted") return failure("ownership_lost");
    if (settlement.kind === "rejected") {
      return failure(
        settlement.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      );
    }
    raw = settlement.value;
  } catch (cause: unknown) {
    return failure(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable");
  }
  const failed = dataRecord(raw, ["ok", "code"]);
  if (failed?.ok === false) {
    if (!isStoreFailureCode(failed.code)) {
      return failure("storage_unavailable");
    }
    return failure(failed.code);
  }
  const committed = dataRecord(raw, ["ok", "request"]);
  const committedRequest = inspectRequestMetadata(committed?.request);
  if (
    committed?.ok !== true ||
    !committedRequest ||
    !hasRequestIdentity(snapshotRequestIdentity(input.request), committedRequest) ||
    !expectedCommitted(native, committedRequest)
  ) {
    return failure("storage_unavailable");
  }
  if (committedRequest.resolutionState !== "pending") {
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(committedRequest));
  }
  const outcome = publicAdmissionOutcome(native);
  return { ok: true, value: Object.freeze({ outcome, request: committedRequest }) };
}

export async function admitClaimedSessionRequest(
  ports: ClaimedSessionRequestAdmissionPorts,
  input: ClaimedSessionRequestAdmissionInput,
): Promise<DomainResult<ClaimedSessionRequestAdmissionOutcome>> {
  try {
    return await admitClaimedSessionRequestInternal(ports, input);
  } catch {
    return domainFailure("storage_unavailable", "Claimed request admission failed safely.", true);
  }
}
