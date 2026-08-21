import type { VisibleRootSession } from "../application/list-visible-root-sessions";
import type { DeliveryMetadata, ParticipantDelivery } from "../domain/deliveries";

function publicAdmissionEvidence(delivery: DeliveryMetadata): Record<string, unknown> | undefined {
  const evidence = delivery.admissionEvidence;
  if (!evidence) return undefined;
  return {
    native_message_id: evidence.nativeMessageId,
    state: evidence.state,
    admitted_seq: evidence.admittedSeq,
    ...(evidence.state === "promoted" ? { promoted_seq: evidence.promotedSeq } : {}),
    observed_at_ms: evidence.observedAtMs,
  };
}

export function publicDelivery(delivery: DeliveryMetadata): Record<string, unknown> {
  return {
    delivery_id: delivery.id,
    source_session_id: delivery.sourceSessionId,
    target_session_id: delivery.targetSessionId,
    native_message_id: delivery.nativeMessageId,
    state: delivery.state,
    content_byte_length: delivery.contentByteLength,
    created_at_ms: delivery.createdAtMs,
    updated_at_ms: delivery.updatedAtMs,
    ...(delivery.submittedAtMs === undefined ? {} : { submitted_at_ms: delivery.submittedAtMs }),
    ...(delivery.admissionUnknownAtMs === undefined
      ? {}
      : { admission_unknown_at_ms: delivery.admissionUnknownAtMs }),
    ...(delivery.admittedAtMs === undefined ? {} : { admitted_at_ms: delivery.admittedAtMs }),
    ...(delivery.promotedAtMs === undefined ? {} : { promoted_at_ms: delivery.promotedAtMs }),
    ...(delivery.failedAtMs === undefined ? {} : { failed_at_ms: delivery.failedAtMs }),
    ...(delivery.cancelledAtMs === undefined ? {} : { cancelled_at_ms: delivery.cancelledAtMs }),
    ...(delivery.admissionEvidence === undefined
      ? {}
      : { admission_evidence: publicAdmissionEvidence(delivery) }),
  };
}

export function publicParticipantDelivery(value: ParticipantDelivery): Record<string, unknown> {
  return { role: value.role, delivery: publicDelivery(value.delivery) };
}

export function publicSession(value: VisibleRootSession): Record<string, unknown> {
  return {
    session_id: value.id,
    title: value.title,
    status: value.status,
    is_active: value.isActive,
    is_archived: value.isArchived,
    updated_at_ms: value.updatedAtMs,
    status_observed_at_ms: value.statusObservedAtMs,
  };
}
