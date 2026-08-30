import type { ProjectionSafeMessage } from "../../src/domain/session-read";

export function projectionTextBytes(messages: readonly ProjectionSafeMessage[]): number {
  let bytes = 0;
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "text") bytes += new TextEncoder().encode(part.text).length;
    }
  }
  return bytes;
}

export function examinedParts(messages: readonly ProjectionSafeMessage[]): number {
  return messages.reduce(
    (total, message) => total + (message.type === "assistant" ? message.parts.length : 0),
    0,
  );
}

export function nativePageFixture(
  messages: ProjectionSafeMessage[],
  nextCursor: string | null = null,
) {
  return {
    messages,
    examinedMessageCount: messages.length,
    projectedTextByteCount: projectionTextBytes(messages),
    examinedPartCount: examinedParts(messages),
    previousCursor: null,
    nextCursor,
  };
}

export function nativeFoundFixture(message: ProjectionSafeMessage) {
  return {
    kind: "found" as const,
    message,
    projectedTextByteCount: projectionTextBytes([message]),
    examinedPartCount: examinedParts([message]),
  };
}
