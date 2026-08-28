import type { NativeQueueAdmission } from "../../application/delivery-ports";
import type { NativeSteerAdmission } from "../../application/request-ports";
import type { NativeMessageId } from "../../domain/generated-ids";
import type { SessionId } from "../../domain/sessions";

interface AdmissionTarget {
  readonly targetSessionId: SessionId;
  readonly nativeMessageId: NativeMessageId;
  readonly envelope: string;
}

type AdmissionDelivery = "queue" | "steer";
type NativeAdmission = NativeQueueAdmission | NativeSteerAdmission;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotExactData(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  try {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)) || keys.length < 2)
      return undefined;
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function safeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function observedTime(data: Record<string, unknown>, now: () => number): number | undefined {
  // The 1.18 line's successful admission response makes timeCreated authoritative.
  // The injected clock is used only when that field is absent, never when native evidence is invalid.
  if ("timeCreated" in data) {
    const timeCreated = data.timeCreated;
    return Number.isSafeInteger(timeCreated) && (timeCreated as number) >= 0
      ? (timeCreated as number)
      : undefined;
  }
  const fallback = now();
  return Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : undefined;
}

export function parseAdmissionResponse(
  response: unknown,
  target: AdmissionTarget,
  now: () => number,
  expectedDelivery: AdmissionDelivery = "queue",
): NativeAdmission {
  if (!isRecord(response) || response.error !== undefined || !isRecord(response.data)) {
    return { kind: "unknown" };
  }
  const body = response.data;
  if (!isRecord(body.data)) return { kind: "unknown" };
  const data = body.data;
  if (
    data.sessionID !== target.targetSessionId ||
    data.id !== target.nativeMessageId ||
    data.delivery !== expectedDelivery ||
    !isRecord(data.prompt) ||
    data.prompt.text !== target.envelope ||
    !safeSequence(data.admittedSeq)
  ) {
    return { kind: "unknown" };
  }
  const observedAtMs = observedTime(data, now);
  if (observedAtMs === undefined) return { kind: "unknown" };
  if (data.promotedSeq === undefined) {
    return { kind: "admitted", admittedSeq: data.admittedSeq, observedAtMs };
  }
  if (!safeSequence(data.promotedSeq) || data.promotedSeq <= data.admittedSeq) {
    return { kind: "unknown" };
  }
  return {
    kind: "promoted",
    admittedSeq: data.admittedSeq,
    promotedSeq: data.promotedSeq,
    observedAtMs,
  };
}

export function isAuthoritativeClientRejection(
  response: unknown,
  aborted: boolean,
  expectedTargetSessionId?: SessionId,
): boolean {
  if (aborted) return false;
  const envelope = snapshotExactData(response, ["error", "response"]);
  if (!envelope || envelope.error === undefined || !(envelope.response instanceof Response))
    return false;
  const status = envelope.response.status;
  if (![400, 401, 404].includes(status)) return false;
  const allowed =
    status === 400
      ? ["_tag", "message", "kind", "field"]
      : status === 404
        ? ["_tag", "sessionID", "message"]
        : ["_tag", "message"];
  const error = snapshotExactData(envelope.error, allowed);
  if (!error || !boundedString(error.message)) return false;
  if (status === 400) {
    if (error._tag !== "InvalidRequestError") return false;
    for (const optional of ["kind", "field"]) {
      if (Object.hasOwn(error, optional) && !boundedString(error[optional], 256)) return false;
    }
    return true;
  }
  if (status === 401) return error._tag === "UnauthorizedError";
  return (
    error._tag === "SessionNotFoundError" &&
    expectedTargetSessionId !== undefined &&
    error.sessionID === expectedTargetSessionId
  );
}
