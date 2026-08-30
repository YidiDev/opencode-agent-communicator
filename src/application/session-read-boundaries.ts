import { type DomainResult, domainFailure } from "../domain/results";
import {
  type ProjectionSafeAssistantPart,
  type ProjectionSafeMessage,
  sessionReadLimits,
} from "../domain/session-read";
import type { SessionReadPresence } from "./delivery-ports";
import type { NativeFixedMessageResult, NativeMessagePage } from "./session-read-ports";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

const encoder = new TextEncoder();

function safeToken(
  value: unknown,
  maximum: number = sessionReadLimits.maxNativeCursorCharacters,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function snapshotPart(value: unknown): ProjectionSafeAssistantPart | undefined {
  const record = snapshotDataRecord(value, 4);
  if (!record || !safeToken(record.itemKey, 256)) return undefined;
  if (
    record.type === "text" &&
    Object.keys(record).length === 3 &&
    typeof record.text === "string" &&
    record.text.length <= 1_048_576
  )
    return { type: "text", itemKey: record.itemKey, text: record.text };
  if (
    record.type === "tool" &&
    Object.keys(record).length === 4 &&
    typeof record.name === "string" &&
    record.name.length <= 256 &&
    (record.status === "pending" ||
      record.status === "running" ||
      record.status === "completed" ||
      record.status === "error")
  )
    return { type: "tool", itemKey: record.itemKey, name: record.name, status: record.status };
  return undefined;
}

function snapshotMessage(value: unknown): ProjectionSafeMessage | undefined {
  const record = snapshotDataRecord(value, 4);
  if (!record || !safeToken(record.messageId, 256)) return undefined;
  if (record.type === "user" && Object.keys(record).length === 2)
    return { type: "user", messageId: record.messageId };
  if (
    record.type !== "assistant" ||
    Object.keys(record).length !== 4 ||
    (record.state !== "active" && record.state !== "completed" && record.state !== "error")
  )
    return undefined;
  const values = snapshotDenseArray(record.parts, 4_096);
  if (!values) return undefined;
  const parts: ProjectionSafeAssistantPart[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const part = snapshotPart(value);
    if (!part || seen.has(part.itemKey)) return undefined;
    seen.add(part.itemKey);
    parts.push(part);
  }
  return { type: "assistant", messageId: record.messageId, state: record.state, parts };
}

function projectedTextByteCount(message: ProjectionSafeMessage): number {
  if (message.type === "user") return 0;
  let bytes = 0;
  for (const part of message.parts)
    if (part.type === "text") bytes += encoder.encode(part.text).length;
  return bytes;
}

export function snapshotNativeMessagePage(
  value: unknown,
  maximumProjectedTextBytes: number,
): NativeMessagePage | undefined {
  const record = snapshotDataRecord(value, 6);
  if (!record || Object.keys(record).length !== 6) return undefined;
  const values = snapshotDenseArray(record.messages, sessionReadLimits.nativePageMessages);
  if (
    !values ||
    !Number.isSafeInteger(record.examinedMessageCount) ||
    (record.examinedMessageCount as number) < 0 ||
    (record.examinedMessageCount as number) > sessionReadLimits.nativePageMessages ||
    !Number.isSafeInteger(record.projectedTextByteCount) ||
    (record.projectedTextByteCount as number) < 0 ||
    (record.projectedTextByteCount as number) > maximumProjectedTextBytes ||
    !Number.isSafeInteger(record.examinedPartCount) ||
    (record.examinedPartCount as number) < 0 ||
    (record.examinedPartCount as number) > sessionReadLimits.maxPartsExamined ||
    !(record.previousCursor === null || safeToken(record.previousCursor)) ||
    !(record.nextCursor === null || safeToken(record.nextCursor))
  )
    return undefined;
  const messages: ProjectionSafeMessage[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const message = snapshotMessage(value);
    if (!message || seen.has(message.messageId)) return undefined;
    seen.add(message.messageId);
    messages.push(message);
  }
  if (messages.length > (record.examinedMessageCount as number)) return undefined;
  const retainedParts = messages.reduce(
    (total, message) => total + (message.type === "assistant" ? message.parts.length : 0),
    0,
  );
  if (retainedParts > (record.examinedPartCount as number)) return undefined;
  const exactBytes = messages.reduce(
    (total, message) => total + projectedTextByteCount(message),
    0,
  );
  if (exactBytes !== record.projectedTextByteCount) return undefined;
  return {
    messages,
    examinedMessageCount: record.examinedMessageCount as number,
    projectedTextByteCount: exactBytes,
    examinedPartCount: record.examinedPartCount as number,
    previousCursor: record.previousCursor as string | null,
    nextCursor: record.nextCursor as string | null,
  };
}

export function snapshotNativeFixedMessage(
  value: unknown,
  expectedMessageId?: string,
): NativeFixedMessageResult | undefined {
  const record = snapshotDataRecord(value, 4);
  if (!record) return undefined;
  if (record.kind === "not_found" && Object.keys(record).length === 1) return { kind: "not_found" };
  if (record.kind !== "found" || Object.keys(record).length !== 4) return undefined;
  const message = snapshotMessage(record.message);
  if (message && expectedMessageId !== undefined && message.messageId !== expectedMessageId)
    return undefined;
  if (
    !message ||
    !Number.isSafeInteger(record.projectedTextByteCount) ||
    (record.projectedTextByteCount as number) < 0 ||
    (record.projectedTextByteCount as number) > sessionReadLimits.maxProjectedTextBytesExamined ||
    projectedTextByteCount(message) !== record.projectedTextByteCount
  )
    return undefined;
  const retainedParts = message.type === "assistant" ? message.parts.length : 0;
  if (
    !Number.isSafeInteger(record.examinedPartCount) ||
    (record.examinedPartCount as number) < retainedParts ||
    (message.type === "user" && record.examinedPartCount !== 0) ||
    (record.examinedPartCount as number) > sessionReadLimits.maxPartsExamined
  )
    return undefined;
  return {
    kind: "found",
    message,
    projectedTextByteCount: record.projectedTextByteCount as number,
    examinedPartCount: record.examinedPartCount as number,
  };
}

export function snapshotSessionReadPresence(value: unknown): SessionReadPresence | undefined {
  const record = snapshotDataRecord(value, 4);
  if (
    !record ||
    Object.keys(record).length !== 4 ||
    typeof record.sourceVisible !== "boolean" ||
    typeof record.targetVisible !== "boolean" ||
    (record.targetStatus !== "busy" &&
      record.targetStatus !== "retry" &&
      record.targetStatus !== "idle" &&
      record.targetStatus !== "unknown") ||
    !Number.isSafeInteger(record.observedAtMs) ||
    (record.observedAtMs as number) < 0
  )
    return undefined;
  return {
    sourceVisible: record.sourceVisible,
    targetVisible: record.targetVisible,
    targetStatus: record.targetStatus,
    observedAtMs: record.observedAtMs as number,
  };
}

export function sessionReadVisibilityFailure(
  value: SessionReadPresence,
): DomainResult<never> | undefined {
  if (!value.sourceVisible)
    return domainFailure("caller_not_visible", "Caller is not currently visible.", false);
  if (!value.targetVisible)
    return domainFailure("target_not_visible", "Target is not currently visible.", false);
  return undefined;
}
