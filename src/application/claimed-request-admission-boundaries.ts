import { type FencingToken, validateFencingToken } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import type { OperationControl } from "./delivery-ports";
import type {
  NativeSteerAdmission,
  RequestAdmissionPersistencePort,
  RequestStoreFailureCode,
} from "./request-ports";

interface ClaimedAdmissionBoundaryInput {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: FencingToken;
  readonly request: RequestMetadata & { readonly deliveryState: "submitting" };
  readonly envelope: string;
  readonly control: OperationControl;
  readonly effectSignal: AbortSignal;
}

export function requestAdmissionFailure(code: RequestStoreFailureCode): DomainResult<never> {
  if (code === "ownership_lost")
    return domainFailure(code, "Coordinator ownership was lost.", false);
  if (code === "state_conflict")
    return domainFailure(code, "Request state changed concurrently.", false);
  return domainFailure(code, "Request persistence is unavailable.", code === "storage_unavailable");
}

export function dataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return undefined;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    !keys.every((key) => own.includes(key))
  )
    return undefined;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

export function inspectNativeAdmission(value: unknown): NativeSteerAdmission {
  const base = dataRecord(value, ["kind"]);
  if (base && (base.kind === "unknown" || base.kind === "definitive_rejection"))
    return { kind: base.kind };
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

export function expectedCommitted(native: NativeSteerAdmission, request: RequestMetadata): boolean {
  if (native.kind === "unknown") return request.deliveryState === "delivery_unknown";
  if (native.kind === "definitive_rejection") return request.deliveryState === "delivery_failed";
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

export function completionInput(
  input: ClaimedAdmissionBoundaryInput,
  native: NativeSteerAdmission,
): Parameters<RequestAdmissionPersistencePort["completeDelivery"]>[0] {
  const base = {
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    requestId: input.request.id,
  };
  if (native.kind === "unknown") return { ...base, outcome: "delivery_unknown" };
  if (native.kind === "definitive_rejection") return { ...base, outcome: "delivery_failed" };
  if (native.kind === "admitted")
    return {
      ...base,
      outcome: "admitted",
      nativeMessageId: input.request.nativeMessageId,
      admittedSeq: native.admittedSeq,
      evidenceObservedAtMs: native.observedAtMs,
    };
  return {
    ...base,
    outcome: "promoted",
    nativeMessageId: input.request.nativeMessageId,
    admittedSeq: native.admittedSeq,
    promotedSeq: native.promotedSeq,
    evidenceObservedAtMs: native.observedAtMs,
  };
}

export function validAdmissionInput(input: ClaimedAdmissionBoundaryInput): boolean {
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

export function publicAdmissionOutcome(
  native: NativeSteerAdmission,
): "delivery_unknown" | "delivery_failed" | "admitted" | "promoted" {
  if (native.kind === "unknown") return "delivery_unknown";
  if (native.kind === "definitive_rejection") return "delivery_failed";
  return native.kind;
}
