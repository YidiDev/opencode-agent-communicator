import { createHash } from "node:crypto";

import type { PrepareRequestInput } from "../../application/request-ports";
import { requestLimits, requestProtocol } from "../../domain/request-constants";
import { isCoherentRequestMetadata } from "../../domain/request-metadata";
import {
  deserializePendingRequestPayload,
  verifiedRequestEnvelopeTrust,
} from "../../domain/request-serialization";
import type { PendingRequestMetadata, RequestMetadata } from "../../domain/request-types";

export interface PreparedContent {
  readonly payloadJson: string;
  readonly envelopeJson: string;
  readonly retainedContentBytes: number;
}

function exactEnvelope(
  request: PendingRequestMetadata & { readonly deliveryState: "prepared" },
  payload: unknown,
  envelopeJson: string,
): boolean {
  const expected = {
    protocol: requestProtocol,
    operation: request.kind,
    request_id: request.id,
    native_message_id: request.nativeMessageId,
    source_session_id: request.sourceSessionId,
    target_session_id: request.targetSessionId,
    workspace_key: request.workspaceKey,
    created_at_ms: request.createdAtMs,
    deadline_at_ms: request.deadlineAtMs,
    payload_byte_length: request.payloadByteLength,
    payload_sha256: request.payloadSha256,
    payload,
    trust: verifiedRequestEnvelopeTrust,
  };
  return JSON.stringify(expected) === envelopeJson;
}

export function validatePreparedContent(
  request: PendingRequestMetadata & { readonly deliveryState: "prepared" },
  payloadJson: unknown,
  envelopeJson: unknown,
): PreparedContent | undefined {
  if (
    !isCoherentRequestMetadata(request) ||
    request.updatedAtMs !== request.createdAtMs ||
    typeof payloadJson !== "string" ||
    typeof envelopeJson !== "string"
  ) {
    return undefined;
  }
  const payload = deserializePendingRequestPayload(payloadJson);
  if (!payload.ok || payload.value.kind !== request.kind) return undefined;
  const timeoutMs = payload.value.timeoutSeconds * 1_000;
  const expectedDeadline = request.createdAtMs + timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(expectedDeadline) ||
    expectedDeadline !== request.deadlineAtMs
  ) {
    return undefined;
  }
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const envelopeBytes = new TextEncoder().encode(envelopeJson).length;
  const retainedContentBytes = payloadBytes.length + envelopeBytes;
  if (
    payloadBytes.length !== request.payloadByteLength ||
    envelopeBytes < 1 ||
    envelopeBytes > requestLimits.envelopeBytes ||
    !Number.isSafeInteger(retainedContentBytes) ||
    retainedContentBytes > requestLimits.canonicalContentBytes + requestLimits.envelopeBytes
  ) {
    return undefined;
  }
  const digest = createHash("sha256").update(payloadBytes).digest("hex");
  return digest === request.payloadSha256 && exactEnvelope(request, payload.value, envelopeJson)
    ? { payloadJson, envelopeJson, retainedContentBytes }
    : undefined;
}

export function exactPreparedReplay(
  existing: RequestMetadata,
  input: PrepareRequestInput,
  row: { readonly payloadJson: unknown; readonly envelopeJson: unknown },
): boolean {
  const candidate = input.request;
  return (
    existing.resolutionState === "pending" &&
    existing.id === candidate.id &&
    existing.nativeMessageId === candidate.nativeMessageId &&
    existing.workspaceKey === candidate.workspaceKey &&
    existing.sourceSessionId === candidate.sourceSessionId &&
    existing.targetSessionId === candidate.targetSessionId &&
    existing.kind === candidate.kind &&
    existing.createdAtMs === candidate.createdAtMs &&
    existing.deadlineAtMs === candidate.deadlineAtMs &&
    existing.payloadByteLength === candidate.payloadByteLength &&
    existing.payloadSha256 === candidate.payloadSha256 &&
    row.payloadJson === input.payloadJson &&
    row.envelopeJson === input.envelopeJson
  );
}
