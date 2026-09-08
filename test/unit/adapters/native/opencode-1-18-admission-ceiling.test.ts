import { expect, test } from "bun:test";

import { createOpenCode118NativeAdapter } from "../../../../src/adapters/native/opencode-1-18";
import { validateDeliveryId, validateNativeMessageId } from "../../../../src/domain/generated-ids";
import {
  maximumMessageContentBytes,
  serializeVerifiedMessageEnvelope,
} from "../../../../src/domain/message-payload";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
): Value {
  if (!result.ok) throw new Error("invalid generated-client fixture");
  return result.value;
}

const sessionId = valid(validateSessionId(`ses_${"a".repeat(124)}`));
const sourceSessionId = valid(validateSessionId(`ses_${"s".repeat(124)}`));
const messageId = valid(validateNativeMessageId(`msg_${"b".repeat(32)}`));
const deliveryId = valid(validateDeliveryId(`dlv_${"c".repeat(32)}`));
const workspaceKey = valid(validateWorkspaceKey("workspace:admission-ceiling"));
const maximumInitialMessage = "\u0001".repeat(maximumMessageContentBytes);
const serializedEnvelope = serializeVerifiedMessageEnvelope({
  sourceSessionId,
  targetSessionId: sessionId,
  workspaceKey,
  deliveryId,
  content: '"'.repeat(32_400),
  sourceTitle: "Source",
});
const textEncoder = new TextEncoder();

function expectNearLimitSerializedEnvelope(): void {
  expect(textEncoder.encode(serializedEnvelope).length).toBeGreaterThan(63 * 1_024);
  expect(textEncoder.encode(serializedEnvelope).length).toBeLessThanOrEqual(64 * 1_024);
}

function expectExpandedWithinAdmissionCeiling(bytes: number, minimumBytes = 128 * 1_024): void {
  expect(bytes).toBeGreaterThan(minimumBytes);
  expect(bytes).toBeLessThan(256 * 1_024);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function generatedAdapter(fetchImplementation: typeof globalThis.fetch) {
  const client = {
    _client: {
      getConfig: () => ({ fetch: fetchImplementation, headers: new Headers() }),
    },
    session: {
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      abort: async () => ({ data: true }),
    },
  };
  return createOpenCode118NativeAdapter(
    {
      client,
      directory: "/workspace",
      serverUrl: new URL("http://127.0.0.1:4321"),
      workspaceKey,
      projectId: "project",
    },
    { now: () => 9_000 },
  );
}

function publicReadBack(text: string, includeLargeValidMetadata = false): Record<string, unknown> {
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "user",
      time: { created: 1 },
      agent: "worker",
      model: { providerID: "provider", modelID: "model" },
      ...(includeLargeValidMetadata ? { system: "s".repeat(1_024) } : {}),
    },
    parts: [
      {
        id: "prt_large",
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text,
      },
    ],
  };
}

test("generated public queue accepts a near-limit serialized-envelope read-back", async () => {
  expectNearLimitSerializedEnvelope();
  const readBack = publicReadBack(serializedEnvelope, true);
  expectExpandedWithinAdmissionCeiling(textEncoder.encode(JSON.stringify(readBack)).length);
  const adapter = generatedAdapter((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return request.method === "POST" ? new Response(null, { status: 204 }) : jsonResponse(readBack);
  }) as typeof globalThis.fetch);

  await expect(
    adapter.queueMessage({
      targetSessionId: sessionId,
      nativeMessageId: messageId,
      envelope: serializedEnvelope,
      abort: new AbortController().signal,
    }),
  ).resolves.toEqual({ kind: "public_message", observedAtMs: 9_000 });
});

test("generated V2 steer accepts a near-limit serialized-envelope response", async () => {
  expectNearLimitSerializedEnvelope();
  const data = {
    data: {
      admittedSeq: 7,
      id: messageId,
      sessionID: sessionId,
      prompt: {
        text: serializedEnvelope,
        files: [{ uri: `file://${"x".repeat(1_024)}` }],
      },
      delivery: "steer",
      timeCreated: 8_000,
    },
  };
  expectExpandedWithinAdmissionCeiling(textEncoder.encode(JSON.stringify(data)).length);
  const adapter = generatedAdapter((async () =>
    jsonResponse(data)) as unknown as typeof globalThis.fetch);

  await expect(
    adapter.steerRequest({
      targetSessionId: sessionId,
      nativeMessageId: messageId,
      envelope: serializedEnvelope,
      abort: new AbortController().signal,
    }),
  ).resolves.toEqual({ kind: "admitted", admittedSeq: 7, observedAtMs: 8_000 });
});

test("generated initial-message flow accepts maximum raw control-character content", async () => {
  const readBack = publicReadBack(maximumInitialMessage);
  expectExpandedWithinAdmissionCeiling(textEncoder.encode(JSON.stringify(readBack)).length);
  let requestBytes = 0;
  const adapter = generatedAdapter((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      requestBytes = (await request.clone().arrayBuffer()).byteLength;
      return new Response(null, { status: 204 });
    }
    return jsonResponse(readBack);
  }) as typeof globalThis.fetch);

  await expect(
    adapter.admitInitialMessage({
      sessionId,
      nativeMessageId: messageId,
      message: maximumInitialMessage,
      abort: new AbortController().signal,
    }),
  ).resolves.toBe("admitted");
  expectExpandedWithinAdmissionCeiling(requestBytes);
});

test("generated rejection correlation reads a near-limit serialized-envelope request", async () => {
  expectNearLimitSerializedEnvelope();
  let requestBytes = 0;
  const adapter = generatedAdapter((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requestBytes = (await request.clone().arrayBuffer()).byteLength;
    return jsonResponse({ _tag: "InvalidRequestError", message: "invalid" }, 400);
  }) as typeof globalThis.fetch);

  await expect(
    adapter.admitInitialMessage({
      sessionId,
      nativeMessageId: messageId,
      message: serializedEnvelope,
      agent: "a".repeat(128),
      model: `p/${"m".repeat(125)}`,
      abort: new AbortController().signal,
    }),
  ).resolves.toBe("definitive_rejection");
  expectExpandedWithinAdmissionCeiling(requestBytes, 127 * 1_024);
});

test("generated admission fails closed above the immutable response ceiling", async () => {
  const adapter = generatedAdapter(
    (async () =>
      new Response(new Uint8Array(256 * 1_024 + 1), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch,
  );

  await expect(
    adapter.steerRequest({
      targetSessionId: sessionId,
      nativeMessageId: messageId,
      envelope: serializedEnvelope,
      abort: new AbortController().signal,
    }),
  ).resolves.toEqual({ kind: "unknown" });
});
