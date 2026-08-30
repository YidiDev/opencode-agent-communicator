import { createHash } from "node:crypto";

import type { PrepareRequestInput } from "../../application/request-ports";
import { requestLimits, requestProtocol } from "../../domain/request-constants";
import { isCoherentRequestMetadata } from "../../domain/request-metadata";
import {
  deserializePendingRequestPayload,
  verifiedRequestEnvelopeTrust,
} from "../../domain/request-serialization";
import type {
  PendingRequestMetadata,
  PendingRequestPayload,
  RequestMetadata,
} from "../../domain/request-types";

export interface PreparedContent {
  readonly payloadJson: string;
  readonly envelopeJson: string;
  readonly retainedContentBytes: number;
}

export interface PendingPrivateContent extends PreparedContent {
  readonly payload: PendingRequestPayload;
}

function exactEnvelope(
  request: PendingRequestMetadata,
  payload: unknown,
  envelopeJson: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeJson);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const candidate = parsed as Record<string, unknown>;
  let work: Record<string, unknown> | undefined;
  if (candidate.work !== undefined) {
    if (
      typeof candidate.work !== "object" ||
      candidate.work === null ||
      Array.isArray(candidate.work)
    )
      return false;
    const raw = candidate.work as Record<string, unknown>;
    if (typeof raw.content !== "string") return false;
    const bytes = new TextEncoder().encode(raw.content);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (raw.byte_length !== bytes.length || raw.sha256 !== digest) return false;
    work = { content: raw.content, byte_length: bytes.length, sha256: digest };
  }
  const responseTool = request.kind === "ask" ? "session_respond" : "session_signal";
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
    response: { tool: responseTool, request_id: request.id },
    ...(work === undefined ? {} : { work }),
    trust: verifiedRequestEnvelopeTrust,
  };
  return JSON.stringify(expected) === envelopeJson;
}

export function validatePendingPrivateContent(
  request: PendingRequestMetadata,
  payloadJson: unknown,
  envelopeJson: unknown,
  retainedContentBytes: unknown,
): PendingPrivateContent | undefined {
  if (
    !isCoherentRequestMetadata(request) ||
    typeof payloadJson !== "string" ||
    typeof envelopeJson !== "string"
  ) {
    return undefined;
  }
  const payload = deserializePendingRequestPayload(payloadJson);
  if (!payload.ok || payload.value.kind !== request.kind) return undefined;
  const timeoutMs = payload.value.timeoutSeconds * 1_000;
  const expectedDeadline = request.createdAtMs + timeoutMs;
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const envelopeBytes = new TextEncoder().encode(envelopeJson).length;
  const expectedRetainedBytes = payloadBytes.length + envelopeBytes;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(expectedDeadline) ||
    expectedDeadline !== request.deadlineAtMs ||
    payloadBytes.length !== request.payloadByteLength ||
    envelopeBytes < 1 ||
    envelopeBytes > requestLimits.envelopeBytes ||
    !Number.isSafeInteger(expectedRetainedBytes) ||
    expectedRetainedBytes > requestLimits.canonicalContentBytes + requestLimits.envelopeBytes ||
    retainedContentBytes !== expectedRetainedBytes
  ) {
    return undefined;
  }
  const digest = createHash("sha256").update(payloadBytes).digest("hex");
  return digest === request.payloadSha256 && exactEnvelope(request, payload.value, envelopeJson)
    ? {
        payload: payload.value,
        payloadJson,
        envelopeJson,
        retainedContentBytes: expectedRetainedBytes,
      }
    : undefined;
}

export function validatePreparedContent(
  request: PendingRequestMetadata & { readonly deliveryState: "prepared" },
  payloadJson: unknown,
  envelopeJson: unknown,
): PreparedContent | undefined {
  if (request.updatedAtMs !== request.createdAtMs) return undefined;
  const retainedContentBytes =
    typeof payloadJson === "string" && typeof envelopeJson === "string"
      ? new TextEncoder().encode(payloadJson).length + new TextEncoder().encode(envelopeJson).length
      : undefined;
  return validatePendingPrivateContent(request, payloadJson, envelopeJson, retainedContentBytes);
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
