import { type SessionId, validateSessionId } from "./sessions";

export type TranscriptSessionIdentity =
  | { readonly ok: true; readonly sessionId: SessionId }
  | { readonly ok: false; readonly reason: "empty" | "malformed" | "mixed" };

function ownValue(object: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): object | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value : undefined;
  } catch {
    return undefined;
  }
}

function strictArray(value: unknown, maximum: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum)
      return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) return undefined;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

type MessageIdentity =
  | { readonly ok: true; readonly sessionId: SessionId }
  | { readonly ok: false; readonly reason: "malformed" | "mixed" };

function deriveMessageIdentity(messageValue: unknown): MessageIdentity {
  const message = plainRecord(messageValue);
  const info = message && plainRecord(ownValue(message, "info"));
  const parts = message && strictArray(ownValue(message, "parts"), 10_000);
  if (!message || !info || !parts) return { ok: false, reason: "malformed" };
  const session = validateSessionId(ownValue(info, "sessionID"));
  const messageId = ownValue(info, "id");
  if (!session.ok || typeof messageId !== "string" || messageId.length < 1) {
    return { ok: false, reason: "malformed" };
  }
  for (const partValue of parts) {
    const part = plainRecord(partValue);
    if (!part) return { ok: false, reason: "malformed" };
    const partSession = validateSessionId(ownValue(part, "sessionID"));
    if (!partSession.ok) return { ok: false, reason: "malformed" };
    if (partSession.value !== session.value || ownValue(part, "messageID") !== messageId) {
      return { ok: false, reason: "mixed" };
    }
  }
  return { ok: true, sessionId: session.value };
}

export function deriveTranscriptSessionIdentity(messagesValue: unknown): TranscriptSessionIdentity {
  const messages = strictArray(messagesValue, 10_000);
  if (!messages) return { ok: false, reason: "malformed" };
  if (messages.length === 0) return { ok: false, reason: "empty" };
  let derived: SessionId | undefined;
  for (const messageValue of messages) {
    const identity = deriveMessageIdentity(messageValue);
    if (!identity.ok) return identity;
    if (derived !== undefined && derived !== identity.sessionId)
      return { ok: false, reason: "mixed" };
    derived = identity.sessionId;
  }
  return derived ? { ok: true, sessionId: derived } : { ok: false, reason: "empty" };
}
