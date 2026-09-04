import type { Hooks } from "@opencode-ai/plugin";
import { injectCommunicatorContext } from "../application/inject-communicator-context";

interface TextPart {
  text: string;
}

export interface ChatMessagesTransformBookkeeping {
  readonly inFlight: WeakMap<object, Promise<void>>;
  readonly injectedText: WeakMap<object, string>;
}

export function createChatMessagesTransformBookkeeping(): ChatMessagesTransformBookkeeping {
  return { inFlight: new WeakMap(), injectedText: new WeakMap() };
}

function textParts(messages: unknown): TextPart[] {
  if (!Array.isArray(messages)) return [];
  const result: TextPart[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (
        typeof part === "object" &&
        part !== null &&
        Reflect.get(part, "type") === "text" &&
        typeof Reflect.get(part, "text") === "string"
      ) {
        result.push(part as TextPart);
      }
    }
  }
  return result;
}

function removeOwnedText(part: TextPart, previous: string): void {
  const offset = part.text.length - previous.length;
  if (offset < 0 || !part.text.endsWith(previous) || part.text.indexOf(previous) !== offset) {
    throw new Error("Prior communicator context ownership is ambiguous.");
  }
  part.text = part.text.slice(0, offset);
}

export function createChatMessagesTransform(
  ports: Parameters<typeof injectCommunicatorContext>[0],
  context: Omit<Parameters<typeof injectCommunicatorContext>[1], "messages">,
  bookkeeping = createChatMessagesTransformBookkeeping(),
): NonNullable<Hooks["experimental.chat.messages.transform"]> {
  const { inFlight, injectedText } = bookkeeping;
  return async (_input, output) => {
    if (typeof output.messages !== "object" || output.messages === null) return;
    const existing = inFlight.get(output.messages);
    if (existing) return existing;

    const transform = (async () => {
      const parts = textParts(output.messages);
      for (const part of parts) {
        const previous = injectedText.get(part);
        if (previous) {
          removeOwnedText(part, previous);
          injectedText.delete(part);
        }
      }
      const before = new Map(parts.map((part) => [part, part.text]));
      await injectCommunicatorContext(ports, { ...context, messages: output.messages });
      for (const part of parts) {
        const original = before.get(part);
        if (original !== undefined && part.text !== original) {
          injectedText.set(part, part.text.slice(original.length));
        }
      }
    })();
    inFlight.set(output.messages, transform);
    try {
      await transform;
    } finally {
      if (inFlight.get(output.messages) === transform) inFlight.delete(output.messages);
    }
  };
}
