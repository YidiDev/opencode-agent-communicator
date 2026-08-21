import {
  type DeliveryAdmissionEvidence,
  type DeliveryMetadata,
  isCoherentDeliveryMetadata,
} from "../../domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../domain/generated-ids";
import type { Sha256Digest } from "../../domain/message-payload";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey } from "../../domain/workspaces";
import { StoreIntegrityError } from "./store-types";

export interface DeliveryRow {
  readonly id: unknown;
  readonly workspaceKey: unknown;
  readonly sourceSessionId: unknown;
  readonly targetSessionId: unknown;
  readonly nativeMessageId: unknown;
  readonly state: unknown;
  readonly contentByteLength: unknown;
  readonly contentSha256: unknown;
  readonly createdAtMs: unknown;
  readonly updatedAtMs: unknown;
  readonly submittedAtMs: unknown;
  readonly admissionUnknownAtMs: unknown;
  readonly admittedAtMs: unknown;
  readonly promotedAtMs: unknown;
  readonly failedAtMs: unknown;
  readonly cancelledAtMs: unknown;
  readonly admittedSeq: unknown;
  readonly promotedSeq: unknown;
  readonly evidenceObservedAtMs: unknown;
}

export const deliveryMetadataColumns = `
id,
workspace_key AS workspaceKey,
source_session_id AS sourceSessionId,
target_session_id AS targetSessionId,
native_message_id AS nativeMessageId,
state,
content_byte_length AS contentByteLength,
content_sha256 AS contentSha256,
created_at_ms AS createdAtMs,
updated_at_ms AS updatedAtMs,
submitted_at_ms AS submittedAtMs,
admission_unknown_at_ms AS admissionUnknownAtMs,
admitted_at_ms AS admittedAtMs,
promoted_at_ms AS promotedAtMs,
failed_at_ms AS failedAtMs,
cancelled_at_ms AS cancelledAtMs,
admitted_seq AS admittedSeq,
promoted_seq AS promotedSeq,
evidence_observed_at_ms AS evidenceObservedAtMs`;

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalidRow();
  return value;
}

function invalidRow(): StoreIntegrityError {
  return new StoreIntegrityError("Stored delivery metadata failed strict domain validation.");
}

function admissionEvidence(
  row: DeliveryRow,
  nativeMessageId: DeliveryMetadata["nativeMessageId"],
): DeliveryAdmissionEvidence | undefined {
  if (row.state !== "admitted" && row.state !== "promoted") return undefined;
  const admittedSeq = requiredNumber(row.admittedSeq);
  const observedAtMs = requiredNumber(row.evidenceObservedAtMs);
  if (row.state === "admitted") {
    return { nativeMessageId, state: "admitted", admittedSeq, observedAtMs };
  }
  return {
    nativeMessageId,
    state: "promoted",
    admittedSeq,
    promotedSeq: requiredNumber(row.promotedSeq),
    observedAtMs,
  };
}

export function hydrateDelivery(row: DeliveryRow): DeliveryMetadata {
  const id = validateDeliveryId(row.id);
  const workspace = validateWorkspaceKey(row.workspaceKey);
  const source = validateSessionId(row.sourceSessionId);
  const target = validateSessionId(row.targetSessionId);
  const nativeMessage = validateNativeMessageId(row.nativeMessageId);
  if (!id.ok || !workspace.ok || !source.ok || !target.ok || !nativeMessage.ok) throw invalidRow();
  if (typeof row.state !== "string" || typeof row.contentSha256 !== "string") throw invalidRow();
  const state = row.state;
  if (
    ![
      "prepared",
      "submitting",
      "admission_unknown",
      "admitted",
      "promoted",
      "failed",
      "cancelled",
    ].includes(state)
  ) {
    throw invalidRow();
  }
  const base = {
    id: id.value,
    workspaceKey: workspace.value,
    sourceSessionId: source.value,
    targetSessionId: target.value,
    nativeMessageId: nativeMessage.value,
    contentByteLength: requiredNumber(row.contentByteLength),
    contentSha256: row.contentSha256 as Sha256Digest,
    createdAtMs: requiredNumber(row.createdAtMs),
    updatedAtMs: requiredNumber(row.updatedAtMs),
  };
  let delivery: DeliveryMetadata;
  if (state === "prepared") delivery = { ...base, state: "prepared" };
  else if (state === "submitting") {
    delivery = { ...base, state: "submitting", submittedAtMs: requiredNumber(row.submittedAtMs) };
  } else if (state === "admission_unknown") {
    delivery = {
      ...base,
      state: "admission_unknown",
      submittedAtMs: requiredNumber(row.submittedAtMs),
      admissionUnknownAtMs: requiredNumber(row.admissionUnknownAtMs),
    };
  } else if (state === "failed") {
    delivery = {
      ...base,
      state: "failed",
      submittedAtMs: requiredNumber(row.submittedAtMs),
      failedAtMs: requiredNumber(row.failedAtMs),
    };
  } else if (state === "cancelled") {
    delivery = { ...base, state: "cancelled", cancelledAtMs: requiredNumber(row.cancelledAtMs) };
  } else {
    const evidence = admissionEvidence(row, nativeMessage.value);
    if (!evidence) throw invalidRow();
    delivery =
      state === "admitted"
        ? {
            ...base,
            state: "admitted",
            submittedAtMs: requiredNumber(row.submittedAtMs),
            admittedAtMs: requiredNumber(row.admittedAtMs),
            admissionEvidence: evidence,
          }
        : {
            ...base,
            state: "promoted",
            submittedAtMs: requiredNumber(row.submittedAtMs),
            admittedAtMs: requiredNumber(row.admittedAtMs),
            promotedAtMs: requiredNumber(row.promotedAtMs),
            admissionEvidence: evidence,
          };
  }
  if (!isCoherentDeliveryMetadata(delivery)) throw invalidRow();
  return delivery;
}
