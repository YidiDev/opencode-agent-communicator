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

function safeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function observedTime(data: Record<string, unknown>, now: () => number): number | undefined {
  // 1.18.21's successful admission response makes timeCreated the authoritative observation.
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

export function isAuthoritativeClientRejection(response: unknown, aborted: boolean): boolean {
  if (aborted || !isRecord(response) || response.error === undefined) return false;
  if (!(response.response instanceof Response)) return false;
  const status = response.response.status;
  return Number.isInteger(status) && status >= 400 && status < 500;
}
