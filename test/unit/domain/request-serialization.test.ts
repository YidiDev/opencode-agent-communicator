import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { Sha256DigestPort } from "../../../src/domain/message-payload";
import { requestLimits } from "../../../src/domain/request-constants";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  canonicalizeSerializeAndDigestRetainedRequestResult,
  deserializePendingRequestPayload,
  deserializeRetainedRequestResult,
  serializePendingRequestPayload,
  serializeRetainedRequestResult,
  serializeVerifiedRequestEnvelope,
  verifiedRequestEnvelopeTrust,
} from "../../../src/domain/request-serialization";

const digestPort: Sha256DigestPort = {
  async sha256(input) {
    return new Uint8Array(createHash("sha256").update(input).digest());
  },
};

const askPayload = {
  kind: "ask",
  timeoutSeconds: 1,
  questions: [{ prompt: "Question", options: ["yes"], multiple: false, allowCustom: true }],
} as const;

function envelopeInput(payload: unknown): Record<string, unknown> {
  return {
    requestId: `req_${"a".repeat(32)}`,
    nativeMessageId: `msg_${"b".repeat(32)}`,
    sourceSessionId: "ses_source",
    targetSessionId: "ses_target",
    workspaceKey: "workspace:one",
    createdAtMs: 9_000,
    deadlineAtMs: 10_000,
    payload,
  };
}

describe("canonical request serialization", () => {
  test("retained ask results are self-contained after pending payload erasure", () => {
    const result = { kind: "ask", answers: [["custom"]] };
    const serialized = serializeRetainedRequestResult(result);
    expect(serialized).toBe('{"kind":"ask","answers":[["custom"]]}');
    expect(deserializeRetainedRequestResult(serialized)).toMatchObject({ ok: true, value: result });
    expect(deserializeRetainedRequestResult(` ${serialized}`).ok).toBe(false);
    expect(deserializeRetainedRequestResult('{"kind":"ask","answers":[]}').ok).toBe(false);
  });

  test("round trips only deterministic canonical pending payload JSON", () => {
    const serialized = serializePendingRequestPayload(askPayload);
    expect(deserializePendingRequestPayload(serialized)).toMatchObject({
      ok: true,
      value: askPayload,
    });
    expect(deserializePendingRequestPayload(` ${serialized}`).ok).toBe(false);
    expect(
      deserializePendingRequestPayload('{"timeoutSeconds":30,"questions":[],"kind":"ask"}').ok,
    ).toBe(false);
    expect(deserializePendingRequestPayload(`${serialized} garbage`).ok).toBe(false);
  });

  test("preflights encoded bytes before parsing all oversized JSON classes", () => {
    const oversizedValid = JSON.stringify({
      kind: "wait",
      milestone: "a".repeat(requestLimits.canonicalContentBytes),
      timeoutSeconds: 1,
    });
    const oversizedMalformed = `{${" ".repeat(requestLimits.canonicalContentBytes)}`;
    const oversizedWhitespace = `${" ".repeat(requestLimits.canonicalContentBytes)}${serializePendingRequestPayload(askPayload)}`;
    const oversizedEscapes = `{"kind":"wait","evidence":"${"\\u0061".repeat(6000)}"}`;
    for (const serialized of [oversizedValid, oversizedMalformed, oversizedWhitespace]) {
      expect(deserializePendingRequestPayload(serialized).ok).toBe(false);
    }
    expect(deserializeRetainedRequestResult(oversizedEscapes).ok).toBe(false);
  });

  test("canonicalize+serialize+digest helpers bind all representations", async () => {
    const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(
      digestPort,
      askPayload,
    );
    if (!payload.ok) throw new Error(payload.message);
    expect(payload.serialized).toBe(serializePendingRequestPayload(payload.value));
    expect(payload.byteLength).toBe(payload.bytes.length);
    expect(String(payload.sha256)).toBe(createHash("sha256").update(payload.bytes).digest("hex"));
    const result = await canonicalizeSerializeAndDigestRetainedRequestResult(digestPort, {
      kind: "wait",
      evidence: "done",
    });
    expect(result).toMatchObject({ ok: true, serialized: '{"kind":"wait","evidence":"done"}' });
  });

  test("emits a fresh canonical payload and ignores inherited serialization hooks", async () => {
    const inherited = Object.create({
      toJSON: () => ({ kind: "wait", milestone: "forged", timeoutSeconds: 1 }),
    });
    Object.assign(inherited, {
      kind: "ask",
      questions: [{ prompt: "Q", options: ["A"] }],
      timeoutSeconds: 1,
    });
    const envelope = await serializeVerifiedRequestEnvelope(
      { ...envelopeInput(inherited), operation: "wait" },
      digestPort,
    );
    const parsed = JSON.parse(envelope);
    expect(parsed.operation).toBe("ask");
    expect(parsed.payload).toEqual({
      kind: "ask",
      questions: [{ prompt: "Q", options: ["A"], multiple: false, allowCustom: false }],
      timeoutSeconds: 1,
    });
    expect(parsed.deadline_at_ms).toBe(10_000);
    expect(parsed.created_at_ms).toBe(9_000);
    expect(parsed.trust).toEqual(verifiedRequestEnvelopeTrust);
    const canonical = serializePendingRequestPayload(parsed.payload);
    expect(parsed.payload_byte_length).toBe(new TextEncoder().encode(canonical).length);
    expect(parsed.payload_sha256).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  test("snapshots getters and proxies into ordinary canonical values", async () => {
    let promptReads = 0;
    const question = Object.defineProperties(
      {},
      {
        prompt: {
          enumerable: true,
          get() {
            promptReads += 1;
            return "Getter question";
          },
        },
        options: {
          enumerable: true,
          get() {
            return ["yes"];
          },
        },
      },
    );
    const proxied = new Proxy(
      { kind: "ask", questions: [question], timeoutSeconds: 1 },
      {
        get(target, property, receiver) {
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const envelope = await serializeVerifiedRequestEnvelope(envelopeInput(proxied), digestPort);
    const parsed = JSON.parse(envelope);
    expect(promptReads).toBe(1);
    expect(Object.getPrototypeOf(parsed.payload)).toBe(Object.prototype);
    expect(parsed.payload.questions[0]).toEqual({
      prompt: "Getter question",
      options: ["yes"],
      multiple: false,
      allowCustom: false,
    });
  });

  test("refuses verified provenance for malformed identity, workspace, or deadline", async () => {
    const cases = [
      { requestId: "req_bad" },
      { nativeMessageId: "msg_bad" },
      { sourceSessionId: "bad" },
      { targetSessionId: "ses_source" },
      { workspaceKey: "/unsafe" },
      { createdAtMs: -1 },
      { createdAtMs: 1.5 },
      { deadlineAtMs: -1 },
      { deadlineAtMs: 1.5 },
      { deadlineAtMs: 10_001 },
      { createdAtMs: 0, deadlineAtMs: 0 },
      {
        createdAtMs: Number.MAX_SAFE_INTEGER - 500,
        deadlineAtMs: Number.MAX_SAFE_INTEGER,
      },
      {
        payload: { ...askPayload, timeoutSeconds: 0 },
        deadlineAtMs: 9_000,
      },
    ];
    for (const change of cases) {
      await expect(
        serializeVerifiedRequestEnvelope({ ...envelopeInput(askPayload), ...change }, digestPort),
      ).rejects.toThrow();
    }
  });
});
