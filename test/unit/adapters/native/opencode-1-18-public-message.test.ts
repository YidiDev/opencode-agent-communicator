import { expect, test } from "bun:test";

import {
  admitPublicMessage,
  type PublicMessageSurface,
  snapshotPublicRecord,
  successfulPublicData,
} from "../../../../src/adapters/native/opencode-1-18-public-message";
import { validateNativeMessageId } from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid fixture identity");
  return result.value;
}

const sessionId = valid(validateSessionId("ses_public"));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"a".repeat(32)}`));

function observed(text = "exact message") {
  return {
    data: {
      info: { id: nativeMessageId, sessionID: sessionId, role: "user" },
      parts: [
        {
          id: "prt_public",
          sessionID: sessionId,
          messageID: nativeMessageId,
          type: "text",
          text,
        },
      ],
    },
    response: new Response(null, { status: 200 }),
  };
}

function input(abort = new AbortController().signal) {
  return { sessionId, nativeMessageId, text: "exact message", abort };
}

test("observes admission after one asynchronous public submission", async () => {
  const calls: string[] = [];
  const surface: PublicMessageSurface = {
    async promptAsync() {
      calls.push("post");
      return { data: {}, response: new Response(null, { status: 204 }) };
    },
    async message() {
      calls.push("get");
      return observed();
    },
  };
  expect(await admitPublicMessage(surface, "/workspace", input(), { now: () => 42 })).toEqual({
    kind: "observed",
    observedAtMs: 42,
  });
  expect(calls).toEqual(["post", "get"]);
});

test("reconciles an ambiguous POST without resubmitting it", async () => {
  let posts = 0;
  const surface: PublicMessageSurface = {
    async promptAsync() {
      posts += 1;
      throw new Error("connection dropped after submission");
    },
    async message() {
      return observed();
    },
  };
  expect(await admitPublicMessage(surface, "/workspace", input(), { now: () => 43 })).toEqual({
    kind: "observed",
    observedAtMs: 43,
  });
  expect(posts).toBe(1);
});

test("waits for the exact text part after the user row appears", async () => {
  let reads = 0;
  const surface: PublicMessageSurface = {
    async promptAsync() {
      return { data: {}, response: new Response(null, { status: 204 }) };
    },
    async message() {
      reads += 1;
      return reads === 1
        ? {
            data: { info: { id: nativeMessageId, sessionID: sessionId, role: "user" }, parts: [] },
            response: new Response(null, { status: 200 }),
          }
        : observed();
    },
  };
  expect(
    await admitPublicMessage(surface, "/workspace", input(), {
      now: () => 44,
      wait: async () => {},
      maximumObservations: 2,
    }),
  ).toEqual({ kind: "observed", observedAtMs: 44 });
  expect(reads).toBe(2);
});

test("fails closed on conflicting fixed-message content", async () => {
  const surface: PublicMessageSurface = {
    async promptAsync() {
      return { data: {}, response: new Response(null, { status: 204 }) };
    },
    async message() {
      return observed("conflict");
    },
  };
  expect(
    await admitPublicMessage(surface, "/workspace", input(), {
      wait: async () => {},
      maximumObservations: 1,
    }),
  ).toEqual({ kind: "unknown" });
});

test("rejects contradictory or malformed extra parts", async () => {
  const conflicting = observed();
  conflicting.data.parts.push({
    id: "prt_conflict",
    sessionID: sessionId,
    messageID: nativeMessageId,
    type: "text",
    text: "different",
  });
  const surface: PublicMessageSurface = {
    async promptAsync() {
      return { data: {}, response: new Response(null, { status: 204 }) };
    },
    async message() {
      return conflicting;
    },
  };
  expect(
    await admitPublicMessage(surface, "/workspace", input(), {
      wait: async () => {},
      maximumObservations: 1,
    }),
  ).toEqual({ kind: "unknown" });

  conflicting.data.parts[1] = Object.create(null);
  expect(
    await admitPublicMessage(surface, "/workspace", input(), {
      wait: async () => {},
      maximumObservations: 1,
    }),
  ).toEqual({ kind: "unknown" });
});

test("does not admit an observation that resolves after cancellation", async () => {
  const controller = new AbortController();
  const surface: PublicMessageSurface = {
    async promptAsync() {
      return { data: {}, response: new Response(null, { status: 204 }) };
    },
    async message() {
      controller.abort();
      return observed();
    },
  };
  expect(await admitPublicMessage(surface, "/workspace", input(controller.signal))).toEqual({
    kind: "unknown",
  });
});

test("classifies exact pre-admission rejection without read-back", async () => {
  let reads = 0;
  const surface: PublicMessageSurface = {
    async promptAsync() {
      return {
        error: { _tag: "InvalidRequestError", message: "invalid" },
        request: new Request("http://opencode.internal/session"),
        response: new Response(null, { status: 400 }),
      };
    },
    async message() {
      reads += 1;
      return undefined;
    },
  };
  expect(await admitPublicMessage(surface, "/workspace", input())).toEqual({
    kind: "definitive_rejection",
  });
  expect(reads).toBe(0);
});

test("accepts only plain bounded data records and genuine transport metadata", () => {
  expect(snapshotPublicRecord({ value: 1 }, 1)).toEqual({ value: 1 });
  for (const value of [null, [], new Date(), { first: 1, second: 2 }]) {
    expect(snapshotPublicRecord(value, 1)).toBeUndefined();
  }
  expect(snapshotPublicRecord({ extra: true }, 1, new Set(["value"]))).toBeUndefined();
  expect(
    snapshotPublicRecord(
      {
        get value() {
          return 1;
        },
      },
      1,
    ),
  ).toBeUndefined();
  expect(
    snapshotPublicRecord(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("hostile keys");
          },
        },
      ),
      1,
    ),
  ).toBeUndefined();

  const request = new Request("http://opencode.internal/session");
  expect(
    successfulPublicData(
      { data: "ok", request, response: new Response(null, { status: 200 }) },
      200,
    ),
  ).toBe("ok");
  for (const envelope of [
    {},
    { data: "ok", response: new Response(null, { status: 204 }) },
    { data: "ok", response: Object.create(Response.prototype) },
    { data: "ok", request: Object.create(Request.prototype), response: new Response() },
  ]) {
    expect(successfulPublicData(envelope, 200, true)).toBeUndefined();
  }
  expect(successfulPublicData({ data: "ok" }, 200)).toBe("ok");
});

test("uses bounded default polling and rejects invalid observation clocks", async () => {
  let reads = 0;
  const surface: PublicMessageSurface = {
    async promptAsync() {
      return { data: {}, response: new Response(null, { status: 204 }) };
    },
    async message() {
      reads += 1;
      if (reads === 1) throw new Error("transient read failure");
      return observed();
    },
  };
  expect(
    await admitPublicMessage(surface, "/workspace", input(), {
      now: () => Number.NaN,
      maximumObservations: 2,
    }),
  ).toEqual({ kind: "unknown" });
  expect(reads).toBe(2);
});

test("forwards exact optional agent and model and stops before I/O when already aborted", async () => {
  let submitted: unknown;
  const surface: PublicMessageSurface = {
    async promptAsync(value) {
      submitted = value;
      return { data: {}, response: new Response(null, { status: 204 }) };
    },
    async message() {
      return observed();
    },
  };
  expect(
    await admitPublicMessage(surface, "/workspace", {
      ...input(),
      agent: "worker",
      model: "openai/gpt-5",
    }),
  ).toMatchObject({ kind: "observed" });
  expect(submitted).toMatchObject({
    agent: "worker",
    model: { providerID: "openai", modelID: "gpt-5" },
  });

  const aborted = new AbortController();
  aborted.abort();
  submitted = undefined;
  expect(await admitPublicMessage(surface, "/workspace", input(aborted.signal))).toEqual({
    kind: "unknown",
  });
  expect(submitted).toBeUndefined();
});
