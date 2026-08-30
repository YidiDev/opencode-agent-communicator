import type { DeliveryId, NativeMessageId } from "./generated-ids";
import type { Sha256Digest } from "./message-payload";
import type { SessionId } from "./sessions";
import type { WorkspaceKey } from "./workspaces";

export const deliveryStates = [
  "prepared",
  "submitting",
  "admission_unknown",
  "admitted",
  "promoted",
  "failed",
  "cancelled",
] as const;

export type DeliveryState = (typeof deliveryStates)[number];
export type DeliveryParticipantRole = "source" | "target";

const transitions: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  prepared: ["submitting", "cancelled"],
  // Native evidence may atomically report both admission and promotion before either is persisted.
  submitting: ["admission_unknown", "admitted", "promoted", "failed"],
  admission_unknown: ["admitted", "promoted", "failed"],
  admitted: ["promoted"],
  promoted: [],
  failed: [],
  cancelled: [],
};

export function canTransitionDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return transitions[from].includes(to);
}

export type DeliveryAdmissionEvidence =
  | {
      readonly kind?: "v2_queue";
      readonly nativeMessageId: NativeMessageId;
      readonly state: "admitted";
      readonly admittedSeq: number;
      readonly observedAtMs: number;
    }
  | {
      readonly kind?: "v2_queue";
      readonly nativeMessageId: NativeMessageId;
      readonly state: "promoted";
      readonly admittedSeq: number;
      readonly promotedSeq: number;
      readonly observedAtMs: number;
    }
  | {
      readonly kind: "public_message";
      readonly nativeMessageId: NativeMessageId;
      readonly state: "admitted";
      readonly observedAtMs: number;
    };

export interface DeliveryMetadata {
  readonly id: DeliveryId;
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly nativeMessageId: NativeMessageId;
  readonly state: DeliveryState;
  readonly contentByteLength: number;
  readonly contentSha256: Sha256Digest;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly submittedAtMs?: number;
  readonly admissionUnknownAtMs?: number;
  readonly admittedAtMs?: number;
  readonly promotedAtMs?: number;
  readonly failedAtMs?: number;
  readonly cancelledAtMs?: number;
  readonly admissionEvidence?: DeliveryAdmissionEvidence;
}

function finiteTime(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function transitionTime(delivery: DeliveryMetadata, value: number | undefined): boolean {
  return (
    finiteTime(value) &&
    (value as number) >= delivery.createdAtMs &&
    (value as number) <= delivery.updatedAtMs
  );
}

type TransitionField =
  | "submittedAtMs"
  | "admissionUnknownAtMs"
  | "admittedAtMs"
  | "promotedAtMs"
  | "failedAtMs"
  | "cancelledAtMs"
  | "admissionEvidence";

const transitionFields: readonly TransitionField[] = [
  "submittedAtMs",
  "admissionUnknownAtMs",
  "admittedAtMs",
  "promotedAtMs",
  "failedAtMs",
  "cancelledAtMs",
  "admissionEvidence",
];

function hasOnlyTransitionFields(
  delivery: DeliveryMetadata,
  allowed: readonly TransitionField[],
): boolean {
  return transitionFields.every(
    (field) => allowed.includes(field) || delivery[field] === undefined,
  );
}

function orderedAfter(earlier: number | undefined, later: number | undefined): boolean {
  return (later as number) >= (earlier as number);
}

function coherentAdmissionMetadata(delivery: DeliveryMetadata): boolean {
  const evidence = delivery.admissionEvidence;
  if (
    !evidence ||
    evidence.state !== delivery.state ||
    !transitionTime(delivery, evidence.observedAtMs)
  )
    return false;
  if (evidence.nativeMessageId !== delivery.nativeMessageId) return false;
  if (delivery.state === "admitted") {
    return (
      transitionTime(delivery, delivery.admittedAtMs) &&
      orderedAfter(delivery.submittedAtMs, delivery.admittedAtMs) &&
      (evidence.kind === "public_message" ||
        (Number.isSafeInteger(evidence.admittedSeq) && evidence.admittedSeq >= 0))
    );
  }
  if (evidence.state !== "promoted") return false;
  return (
    transitionTime(delivery, delivery.admittedAtMs) &&
    transitionTime(delivery, delivery.promotedAtMs) &&
    orderedAfter(delivery.submittedAtMs, delivery.admittedAtMs) &&
    orderedAfter(delivery.admittedAtMs, delivery.promotedAtMs) &&
    Number.isSafeInteger(evidence.admittedSeq) &&
    evidence.admittedSeq >= 0 &&
    Number.isSafeInteger(evidence.promotedSeq) &&
    evidence.promotedSeq > evidence.admittedSeq
  );
}

export function isCoherentDeliveryMetadata(delivery: DeliveryMetadata): boolean {
  if (!/^[0-9a-f]{64}$/.test(delivery.contentSha256)) return false;
  if (!finiteTime(delivery.createdAtMs) || !finiteTime(delivery.updatedAtMs)) return false;
  if (delivery.createdAtMs > delivery.updatedAtMs) return false;
  if (
    !Number.isInteger(delivery.contentByteLength) ||
    delivery.contentByteLength < 0 ||
    delivery.contentByteLength > 32 * 1024
  ) {
    return false;
  }
  if (delivery.state === "prepared") return hasOnlyTransitionFields(delivery, []);
  if (delivery.state === "cancelled") {
    return (
      hasOnlyTransitionFields(delivery, ["cancelledAtMs"]) &&
      transitionTime(delivery, delivery.cancelledAtMs)
    );
  }
  if (!transitionTime(delivery, delivery.submittedAtMs)) return false;
  if (delivery.state === "submitting") {
    return hasOnlyTransitionFields(delivery, ["submittedAtMs"]);
  }
  if (delivery.state === "admission_unknown") {
    return (
      hasOnlyTransitionFields(delivery, ["submittedAtMs", "admissionUnknownAtMs"]) &&
      transitionTime(delivery, delivery.admissionUnknownAtMs) &&
      orderedAfter(delivery.submittedAtMs, delivery.admissionUnknownAtMs)
    );
  }
  if (delivery.state === "failed") {
    return (
      hasOnlyTransitionFields(delivery, ["submittedAtMs", "failedAtMs"]) &&
      transitionTime(delivery, delivery.failedAtMs) &&
      orderedAfter(delivery.submittedAtMs, delivery.failedAtMs)
    );
  }
  const admissionFields: readonly TransitionField[] =
    delivery.state === "admitted"
      ? ["submittedAtMs", "admittedAtMs", "admissionEvidence"]
      : ["submittedAtMs", "admittedAtMs", "promotedAtMs", "admissionEvidence"];
  if (!hasOnlyTransitionFields(delivery, admissionFields)) return false;
  return coherentAdmissionMetadata(delivery);
}

export interface ParticipantDelivery {
  readonly role: DeliveryParticipantRole;
  readonly delivery: DeliveryMetadata;
}
