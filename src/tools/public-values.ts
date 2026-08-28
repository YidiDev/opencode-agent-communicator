import type { VisibleRootSession } from "../application/list-visible-root-sessions";
import type {
  ParticipantRequestGet,
  ParticipantRequestMetadata,
} from "../application/request-ports";
import type { DeliveryMetadata, ParticipantDelivery } from "../domain/deliveries";
import type { PendingRequestPayload, RetainedRequestResult } from "../domain/request-types";
import type { SessionExportSummary } from "../domain/session-export";
import type { StartOperation } from "../domain/session-start";

export function publicSessionExport(value: SessionExportSummary): Record<string, unknown> {
  return {
    session_id: value.sessionId,
    destination: value.destination,
    sanitized: value.isSanitized,
    byte_count: value.byteCount,
    content_sha256: value.contentSha256,
  };
}

export function publicStartOperation(value: StartOperation): Record<string, unknown> {
  return {
    operation_id: value.id,
    source_session_id: value.sourceSessionId,
    session_id: value.sessionId,
    native_message_id: value.nativeMessageId,
    idempotency_key: value.idempotencyKey,
    arguments_sha256: value.argumentsSha256,
    creation_state: value.creationState,
    title_state: value.titleState,
    admission_state: value.admissionState,
    created_at_ms: value.createdAtMs,
    updated_at_ms: value.updatedAtMs,
  };
}

function publicAdmissionEvidence(delivery: DeliveryMetadata): Record<string, unknown> | undefined {
  const evidence = delivery.admissionEvidence;
  if (!evidence) return undefined;
  return {
    kind: evidence.kind ?? "v2_queue",
    native_message_id: evidence.nativeMessageId,
    state: evidence.state,
    ...(evidence.kind !== "public_message" ? { admitted_seq: evidence.admittedSeq } : {}),
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

export function publicRequestMetadata(value: ParticipantRequestMetadata): Record<string, unknown> {
  return {
    request_id: value.requestId,
    role: value.participantRole,
    kind: value.kind,
    resolution_state: value.resolutionState,
    delivery_state: value.deliveryState,
    result_state: value.resultState,
    source_session_id: value.sourceSessionId,
    target_session_id: value.targetSessionId,
    created_at_ms: value.createdAtMs,
    updated_at_ms: value.updatedAtMs,
    deadline_at_ms: value.deadlineAtMs,
    acknowledgement_applicable:
      value.resolutionState === "answered" || value.resolutionState === "reached",
    ...(value.resolvedAtMs === undefined ? {} : { resolved_at_ms: value.resolvedAtMs }),
    ...(value.submittedAtMs === undefined ? {} : { submitted_at_ms: value.submittedAtMs }),
    ...(value.deliveryUnknownAtMs === undefined
      ? {}
      : { delivery_unknown_at_ms: value.deliveryUnknownAtMs }),
    ...(value.admittedAtMs === undefined ? {} : { admitted_at_ms: value.admittedAtMs }),
    ...(value.promotedAtMs === undefined ? {} : { promoted_at_ms: value.promotedAtMs }),
    ...(value.deliveryFailedAtMs === undefined
      ? {}
      : { delivery_failed_at_ms: value.deliveryFailedAtMs }),
    ...(value.resultAvailableAtMs === undefined
      ? {}
      : { result_available_at_ms: value.resultAvailableAtMs }),
    ...(value.resultExpiresAtMs === undefined
      ? {}
      : { result_expires_at_ms: value.resultExpiresAtMs }),
    ...(value.resultExpiredAtMs === undefined
      ? {}
      : { result_expired_at_ms: value.resultExpiredAtMs }),
    ...(value.acknowledgedAtMs === undefined ? {} : { acknowledged_at_ms: value.acknowledgedAtMs }),
  };
}

function publicRequestPayload(value: PendingRequestPayload): Record<string, unknown> {
  return value.kind === "ask"
    ? {
        kind: "ask",
        questions: value.questions.map((question) => ({
          prompt: question.prompt,
          options: question.options,
          multiple: question.multiple,
          allow_custom: question.allowCustom,
        })),
        timeout_seconds: value.timeoutSeconds,
      }
    : { kind: "wait", milestone: value.milestone, timeout_seconds: value.timeoutSeconds };
}

function publicRequestResult(value: RetainedRequestResult): Record<string, unknown> {
  return value.kind === "ask"
    ? { kind: "ask", answers: value.answers }
    : { kind: "wait", ...(value.evidence === undefined ? {} : { evidence: value.evidence }) };
}

export function publicParticipantRequest(value: ParticipantRequestGet): Record<string, unknown> {
  return {
    outcome: value.outcome,
    ...(value.outcome === "metadata" ? { view: value.view } : {}),
    metadata: publicRequestMetadata(value.metadata),
    ...(value.outcome === "pending_payload"
      ? { payload: publicRequestPayload(value.payload) }
      : {}),
    ...(value.outcome === "available_result" ? { result: publicRequestResult(value.result) } : {}),
  };
}
