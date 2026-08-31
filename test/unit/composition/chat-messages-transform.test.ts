import { expect, test } from "bun:test";
import { ParticipantOperationGate } from "../../../src/application/participant-operation-gate";
import { createChatMessagesTransform } from "../../../src/composition/chat-messages-transform";
import type { ContextAdmissionMetadata } from "../../../src/domain/context-admissions";
import { validateDeliveryId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const fencingToken = valid(validateFencingToken(1));
const workspaceKey = valid(validateWorkspaceKey("transform-test"));
const target = valid(validateSessionId("ses_target"));
const source = valid(validateSessionId("ses_source"));
const sha256 = "b".repeat(64) as Sha256Digest;

function messages() {
  return [
    {
      info: { id: "msg", sessionID: target, role: "user" },
      parts: [{ type: "text", text: "human prompt", sessionID: target, messageID: "msg" }],
    },
  ];
}

function fixture() {
  let claims = 0;
  let sequence = 0;
  const pending: Array<{
    metadata: ContextAdmissionMetadata;
    envelopeJson: string;
  }> = [];
  const ports: Parameters<typeof createChatMessagesTransform>[0] = {
    readiness: { fencingToken, assertReady: () => {} },
    contexts: {
      createContextMessage: async () => ({ ok: false, code: "state_conflict" }),
      getContextAdmission: async () => undefined,
      listPendingContext: async () =>
        pending.map(({ metadata, envelopeJson }) => ({
          id: metadata.id,
          kind: metadata.kind,
          sourceSessionId: metadata.sourceSessionId,
          envelopeJson,
          contentByteLength: metadata.contentByteLength,
          contentSha256: metadata.contentSha256 as Sha256Digest,
        })),
      claimPendingContext: async ({ items }) => {
        claims += 1;
        return items.map((item) => {
          const index = pending.findIndex(({ metadata }) => metadata.id === item.id);
          const entry = pending.splice(index, 1)[0];
          if (!entry) throw new Error("missing pending fixture");
          return {
            ...entry.metadata,
            state: "context_admitted" as const,
            updatedAtMs: 2,
            contextAdmittedAtMs: 2,
            claimedFencingToken: fencingToken,
          };
        });
      },
      readContextReminders: async () => ({ activeLockCount: 0, availableResults: [] }),
      cancelContextAdmission: async () => ({ ok: false, code: "state_conflict" }),
      failPendingContextForParticipant: async () => [],
      failUncertainContextOnStartup: async () => [],
    },
    participantOperations: new ParticipantOperationGate(),
    notifications: { notifyContextSettled: () => undefined },
    targetEligibility: { isEligibleContextTarget: async () => true },
  };
  return {
    ports,
    enqueue(content: string) {
      sequence += 1;
      const envelopeJson = JSON.stringify({ content });
      pending.push({
        envelopeJson,
        metadata: {
          id: valid(validateDeliveryId(`dlv_${String(sequence).padStart(32, "a")}`)),
          kind: "message",
          workspaceKey,
          sourceSessionId: source,
          targetSessionId: target,
          state: "awaiting_context",
          contentByteLength: new TextEncoder().encode(envelopeJson).length,
          contentSha256: sha256,
          createdAtMs: 1,
          updatedAtMs: 1,
          awaitingContextAtMs: 1,
        },
      });
    },
    claims: () => claims,
  };
}

function createTransform(value: ReturnType<typeof fixture>) {
  return createChatMessagesTransform(value.ports, {
    workspaceKey,
    fencingToken,
    abort: new AbortController().signal,
  });
}

test("treats repeated same-array calls as subsequent provider invocations", async () => {
  const value = fixture();
  const transform = createTransform(value);
  const output = { messages: messages() };
  await transform({} as never, output as never);
  await transform({} as never, output as never);
  expect(value.claims()).toBe(0);
});

test("claims new context on a later same-array invocation without replaying old text", async () => {
  const value = fixture();
  const transform = createTransform(value);
  const output = { messages: messages() };
  value.enqueue("first context");
  await transform({} as never, output as never);
  expect(output.messages[0]?.parts[0]?.text).toContain("first context");

  value.enqueue("second context");
  await transform({} as never, output as never);
  const text = output.messages[0]?.parts[0]?.text ?? "";
  expect(text).toContain("second context");
  expect(text).not.toContain("first context");
  expect(value.claims()).toBe(2);
});

test("removes stale synthetic text when a subsequent invocation has no context", async () => {
  const value = fixture();
  const transform = createTransform(value);
  const output = { messages: messages() };
  value.enqueue("one-shot context");
  await transform({} as never, output as never);
  await transform({} as never, output as never);
  expect(output.messages[0]?.parts[0]?.text).toBe("human prompt");
});

test("removes only owned text after a downstream transform appends content", async () => {
  const value = fixture();
  const transform = createTransform(value);
  const output = { messages: messages() };
  value.enqueue("one-shot context");
  await transform({} as never, output as never);
  const part = output.messages[0]?.parts[0];
  if (!part) throw new Error("missing text part");
  part.text += "\ndownstream reminder";

  await transform({} as never, output as never);
  expect(part.text).toBe("human prompt\ndownstream reminder");
});

test("removes owned text after a downstream transform prepends or rewrites the prompt", async () => {
  const value = fixture();
  const transform = createTransform(value);
  const output = { messages: messages() };
  value.enqueue("one-shot context");
  await transform({} as never, output as never);
  const part = output.messages[0]?.parts[0];
  if (!part) throw new Error("missing text part");
  part.text = `downstream prefix\n${part.text.replace("human prompt", "rewritten prompt")}`;

  await transform({} as never, output as never);
  expect(part.text).toBe("downstream prefix\nrewritten prompt");
});

test("leaves duplicate synthetic text unchanged when cleanup ownership is ambiguous", async () => {
  const value = fixture();
  const transform = createTransform(value);
  const output = { messages: messages() };
  value.enqueue("one-shot context");
  await transform({} as never, output as never);
  const part = output.messages[0]?.parts[0];
  if (!part) throw new Error("missing text part");
  const injected = part.text.slice("human prompt".length);
  part.text = `${injected}\nhuman prompt${injected}`;
  const ambiguous = part.text;

  await transform({} as never, output as never);
  expect(part.text).toBe(ambiguous);
});

test("coalesces concurrent hook calls for one in-flight provider invocation", async () => {
  const value = fixture();
  const transform = createTransform(value);
  const output = { messages: messages() };
  value.enqueue("single context");
  await Promise.all([
    transform({} as never, output as never),
    transform({} as never, output as never),
  ]);
  expect(value.claims()).toBe(1);
  expect(output.messages[0]?.parts[0]?.text.match(/single context/g)).toHaveLength(1);
});

test("ignores primitive outputs and permits retry after injection throws", async () => {
  const value = fixture();
  const transform = createTransform(value);
  for (const candidate of [null, "text", 4]) {
    await transform({} as never, { messages: candidate } as never);
  }
  value.ports.contexts.listPendingContext = async () => {
    throw new Error("context read failed");
  };
  const output = { messages: messages() };
  await expect(transform({} as never, output as never)).rejects.toThrow("context read failed");
  await expect(transform({} as never, output as never)).rejects.toThrow("context read failed");
});
