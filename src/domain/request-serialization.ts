import {
  type NativeMessageId,
  type RequestId,
  validateNativeMessageId,
  validateRequestId,
} from "./generated-ids";
import { digestMessageContent, type Sha256Digest, type Sha256DigestPort } from "./message-payload";
import { requestLimits, requestProtocol } from "./request-constants";
import { validatePendingRequestPayload, validateRetainedRequestResult } from "./request-content";
import type { PendingRequestPayload, RetainedRequestResult } from "./request-types";
import { type RequestValidation, safeInteger } from "./request-validation";
import { type SessionId, validateSessionId } from "./sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "./workspaces";

export const verifiedRequestEnvelopeTrust = {
  provenance: "verified_by_communicator",
  payload: "untrusted_peer_request",
  consequence: "normal_permissions_and_authorization_still_required",
} as const;

export interface VerifiedRequestEnvelopeInput {
  readonly requestId: RequestId;
  readonly nativeMessageId: NativeMessageId;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly workspaceKey: WorkspaceKey;
  readonly createdAtMs: number;
  readonly deadlineAtMs: number;
  readonly payload: PendingRequestPayload;
  readonly work?: Readonly<{
    content: string;
    byteLength: number;
    sha256: Sha256Digest;
  }>;
}

export type CanonicalRequestContentValidation<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
      readonly serialized: string;
      readonly bytes: Uint8Array;
      readonly byteLength: number;
      readonly sha256: Sha256Digest;
    }
  | { readonly ok: false; readonly message: string };

function parseFailure<Value>(message: string): RequestValidation<Value> {
  return { ok: false, message };
}

function preflightSerializedJson<Value>(
  serialized: unknown,
  label: string,
): RequestValidation<Value> | { readonly ok: true; readonly serialized: string } {
  if (typeof serialized !== "string") return parseFailure(`${label} must be a string.`);
  const byteLength = new TextEncoder().encode(serialized).length;
  if (byteLength > requestLimits.canonicalContentBytes) {
    return parseFailure(
      `${label} must not exceed ${requestLimits.canonicalContentBytes} encoded UTF-8 bytes.`,
    );
  }
  return { ok: true, serialized };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function canonicalText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function serializePendingRequestPayload(payload: unknown): string {
  const validated = validatePendingRequestPayload(payload);
  if (!validated.ok) throw new TypeError(validated.message);
  return canonicalText(validated.bytes);
}

export function deserializePendingRequestPayload(
  serialized: unknown,
): RequestValidation<PendingRequestPayload> {
  const preflight = preflightSerializedJson<PendingRequestPayload>(
    serialized,
    "serialized payload",
  );
  if (!preflight.ok || !("serialized" in preflight)) return preflight;
  const validated = validatePendingRequestPayload(parseJson(preflight.serialized));
  if (!validated.ok) return validated;
  return canonicalText(validated.bytes) === preflight.serialized
    ? validated
    : parseFailure("payload JSON is not canonical.");
}

export function serializeRetainedRequestResult(result: unknown): string {
  const validated = validateRetainedRequestResult(result);
  if (!validated.ok) throw new TypeError(validated.message);
  return canonicalText(validated.bytes);
}

export function deserializeRetainedRequestResult(
  serialized: unknown,
): RequestValidation<RetainedRequestResult> {
  const preflight = preflightSerializedJson<RetainedRequestResult>(serialized, "serialized result");
  if (!preflight.ok || !("serialized" in preflight)) return preflight;
  const validated = validateRetainedRequestResult(parseJson(preflight.serialized));
  if (!validated.ok) return validated;
  return canonicalText(validated.bytes) === preflight.serialized
    ? validated
    : parseFailure("result JSON is not canonical.");
}

async function canonicalizeSerializeAndDigest<Value>(
  port: Sha256DigestPort,
  validated: RequestValidation<Value>,
): Promise<CanonicalRequestContentValidation<Value>> {
  if (!validated.ok) return validated;
  const sha256 = await digestMessageContent(port, validated.bytes);
  return {
    ok: true,
    value: validated.value,
    serialized: canonicalText(validated.bytes),
    bytes: validated.bytes,
    byteLength: validated.byteLength,
    sha256,
  };
}

export function canonicalizeSerializeAndDigestPendingRequestPayload(
  port: Sha256DigestPort,
  payload: unknown,
): Promise<CanonicalRequestContentValidation<PendingRequestPayload>> {
  return canonicalizeSerializeAndDigest(port, validatePendingRequestPayload(payload));
}

export function canonicalizeSerializeAndDigestRetainedRequestResult(
  port: Sha256DigestPort,
  result: unknown,
): Promise<CanonicalRequestContentValidation<RetainedRequestResult>> {
  return canonicalizeSerializeAndDigest(port, validateRetainedRequestResult(result));
}

function invalidEnvelope(message: string): never {
  throw new TypeError(message);
}

function isEnvelopeInputRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function envelopeInputRecord(input: unknown): Record<string, unknown> {
  if (!isEnvelopeInputRecord(input)) {
    return invalidEnvelope("request envelope input must be an object.");
  }
  return input;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exact envelope identity validation is kept in one canonical serializer.
export async function serializeVerifiedRequestEnvelope(
  input: unknown,
  digestPort: Sha256DigestPort,
): Promise<string> {
  const candidate = envelopeInputRecord(input);
  const rawRequestId = candidate.requestId;
  const rawNativeMessageId = candidate.nativeMessageId;
  const rawSourceSessionId = candidate.sourceSessionId;
  const rawTargetSessionId = candidate.targetSessionId;
  const rawWorkspaceKey = candidate.workspaceKey;
  const createdAtMs = candidate.createdAtMs;
  const deadlineAtMs = candidate.deadlineAtMs;
  const rawPayload = candidate.payload;
  const rawWork = candidate.work;
  const requestId = validateRequestId(rawRequestId);
  const nativeMessageId = validateNativeMessageId(rawNativeMessageId);
  const sourceSessionId = validateSessionId(rawSourceSessionId);
  const targetSessionId = validateSessionId(rawTargetSessionId);
  const workspaceKey = validateWorkspaceKey(rawWorkspaceKey);
  if (!requestId.ok) return invalidEnvelope(requestId.message);
  if (!nativeMessageId.ok) return invalidEnvelope(nativeMessageId.message);
  if (!sourceSessionId.ok) return invalidEnvelope(sourceSessionId.message);
  if (!targetSessionId.ok) return invalidEnvelope(targetSessionId.message);
  if (sourceSessionId.value === targetSessionId.value) {
    return invalidEnvelope("Request participants must be distinct.");
  }
  if (!workspaceKey.ok) return invalidEnvelope(workspaceKey.message);
  if (!safeInteger(createdAtMs)) return invalidEnvelope("createdAtMs must be a safe integer.");
  if (!safeInteger(deadlineAtMs)) return invalidEnvelope("deadlineAtMs must be a safe integer.");
  const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(digestPort, rawPayload);
  if (!payload.ok) return invalidEnvelope(payload.message);
  const timeoutMs = payload.value.timeoutSeconds * 1000;
  const expectedDeadlineAtMs = createdAtMs + timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(expectedDeadlineAtMs) ||
    expectedDeadlineAtMs <= createdAtMs ||
    deadlineAtMs !== expectedDeadlineAtMs
  ) {
    return invalidEnvelope("deadlineAtMs must exactly bind createdAtMs to the canonical timeout.");
  }
  let work: Record<string, unknown> | undefined;
  if (rawWork !== undefined) {
    if (!isEnvelopeInputRecord(rawWork) || typeof rawWork.content !== "string") {
      return invalidEnvelope("request envelope work must be an object with string content.");
    }
    const bytes = new TextEncoder().encode(rawWork.content);
    const digest = await digestMessageContent(digestPort, bytes);
    if (rawWork.byteLength !== bytes.length || rawWork.sha256 !== digest) {
      return invalidEnvelope("request envelope work identity is invalid.");
    }
    work = { content: rawWork.content, byte_length: bytes.length, sha256: digest };
  }
  const responseTool = payload.value.kind === "ask" ? "session_respond" : "session_signal";
  const envelope = JSON.stringify({
    protocol: requestProtocol,
    operation: payload.value.kind,
    request_id: requestId.value,
    native_message_id: nativeMessageId.value,
    source_session_id: sourceSessionId.value,
    target_session_id: targetSessionId.value,
    workspace_key: workspaceKey.value,
    created_at_ms: createdAtMs,
    deadline_at_ms: deadlineAtMs,
    payload_byte_length: payload.byteLength,
    payload_sha256: payload.sha256,
    payload: payload.value,
    response: { tool: responseTool, request_id: requestId.value },
    ...(work === undefined ? {} : { work }),
    trust: verifiedRequestEnvelopeTrust,
  });
  if (new TextEncoder().encode(envelope).length > requestLimits.envelopeBytes) {
    throw new RangeError(
      `request envelope must not exceed ${requestLimits.envelopeBytes} UTF-8 bytes.`,
    );
  }
  return envelope;
}
