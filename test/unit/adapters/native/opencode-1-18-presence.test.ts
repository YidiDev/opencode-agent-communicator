import { expect, test } from "bun:test";
import {
  classifyOpenCode118DirectSessionPresence,
  createDirectParticipantPresencePort,
} from "../../../../src/adapters/native/opencode-1-18-presence";
import { validateSessionId } from "../../../../src/domain/sessions";

const validated = validateSessionId("ses_presence");
if (!validated.ok) throw new Error("invalid fixture");
const sessionId = validated.value;

function response(status: number): Response {
  return new Response(null, { status });
}

test("classifies only correlated direct V2 success and exact correlated 404 as presence", () => {
  expect(
    classifyOpenCode118DirectSessionPresence(
      { data: { data: { id: sessionId, time: { archived: 1 } } }, response: response(200) },
      sessionId,
    ),
  ).toBe("present");
  expect(
    classifyOpenCode118DirectSessionPresence(
      { data: { data: { id: "ses_other" } }, response: response(200) },
      sessionId,
    ),
  ).toBe("unknown");
  expect(
    classifyOpenCode118DirectSessionPresence(
      {
        error: { _tag: "SessionNotFoundError", sessionID: sessionId, message: "missing" },
        response: response(404),
      },
      sessionId,
    ),
  ).toBe("absent");
  for (const error of [
    { _tag: "SessionNotFoundError", sessionID: "ses_other", message: "missing" },
    { _tag: "FutureError", sessionID: sessionId, message: "missing" },
  ]) {
    expect(
      classifyOpenCode118DirectSessionPresence({ error, response: response(404) }, sessionId),
    ).toBe("unknown");
  }
  expect(
    classifyOpenCode118DirectSessionPresence(
      { error: { _tag: "SessionNotFoundError", sessionID: sessionId, message: "missing" } },
      sessionId,
    ),
  ).toBe("unknown");
});

test("treats every non-404 status and every mixed not-found envelope as unknown", () => {
  const error = { _tag: "SessionNotFoundError", sessionID: sessionId, message: "missing" };
  for (const status of [200, 201, 400, 401, 403, 409, 429, 500, 502, 503]) {
    expect(
      classifyOpenCode118DirectSessionPresence({ error, response: response(status) }, sessionId),
    ).toBe("unknown");
  }
  for (const mixed of [
    { data: undefined, error, response: response(404) },
    { data: { data: { id: sessionId } }, error, response: response(404) },
    { error, response: response(404), unexpected: true },
    { error, response: response(404), request: {}, extra: undefined },
  ]) {
    expect(classifyOpenCode118DirectSessionPresence(mixed, sessionId)).toBe("unknown");
  }
});

test("requires an exact plain-data correlated SessionNotFoundError", () => {
  const exact = { _tag: "SessionNotFoundError", sessionID: sessionId, message: "missing" };
  const inherited = Object.create(exact);
  const nullPrototype = Object.assign(Object.create(null), exact);
  const symbol = { ...exact, [Symbol("hostile")]: true };
  const extra = { ...exact, code: 404 };
  const missing = { _tag: "SessionNotFoundError", sessionID: sessionId };
  const emptyMessage = { ...exact, message: "" };
  const accessor = Object.defineProperty({ ...exact }, "sessionID", {
    enumerable: true,
    get: () => sessionId,
  });
  let accessorReads = 0;
  Object.defineProperty(accessor, "message", {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      return "missing";
    },
  });
  for (const error of [inherited, nullPrototype, symbol, extra, missing, emptyMessage, accessor]) {
    expect(
      classifyOpenCode118DirectSessionPresence({ error, response: response(404) }, sessionId),
    ).toBe("unknown");
  }
  expect(accessorReads).toBe(0);
});

test("rejects hostile 404 envelopes without consulting accessors or proxy traps", () => {
  const error = { _tag: "SessionNotFoundError", sessionID: sessionId, message: "missing" };
  let reads = 0;
  const accessor = Object.defineProperty({ response: response(404) }, "error", {
    enumerable: true,
    get: () => {
      reads += 1;
      return error;
    },
  });
  const inherited = Object.create({ error, response: response(404) });
  const symbol = { error, response: response(404), [Symbol("mixed")]: true };
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("trap");
      },
    },
  );
  for (const envelope of [accessor, inherited, symbol, hostile]) {
    expect(classifyOpenCode118DirectSessionPresence(envelope, sessionId)).toBe("unknown");
  }
  expect(reads).toBe(0);
});

test("requires a branded Response and reads its intrinsic status without trusting properties", () => {
  const error = { _tag: "SessionNotFoundError", sessionID: sessionId, message: "missing" };
  const inheritedResponse = Object.create(Response.prototype);
  const responseProxy = new Proxy(response(404), {});
  const fake = { status: 404 };
  const throwingStatus = Object.defineProperty({}, "status", {
    get: () => {
      throw new Error("must not run");
    },
  });
  for (const nativeResponse of [inheritedResponse, responseProxy, fake, throwingStatus]) {
    expect(
      classifyOpenCode118DirectSessionPresence({ error, response: nativeResponse }, sessionId),
    ).toBe("unknown");
  }
  const branded = response(404);
  Object.defineProperty(branded, "status", { value: 500 });
  expect(classifyOpenCode118DirectSessionPresence({ error, response: branded }, sessionId)).toBe(
    "absent",
  );
});

test("maps aborts, throws, and malformed direct reads to unknown", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let calls = 0;
  const port = createDirectParticipantPresencePort({
    async get() {
      calls += 1;
      throw new Error("transport");
    },
  });
  expect(await port.readParticipantPresence(sessionId, aborted.signal)).toBe("unknown");
  expect(calls).toBe(0);
  expect(await port.readParticipantPresence(sessionId, new AbortController().signal)).toBe(
    "unknown",
  );
  expect(calls).toBe(1);
});

test("rejects hostile successful envelopes without invoking accessors", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "data", {
    enumerable: true,
    get: () => {
      reads += 1;
      return { data: { id: sessionId } };
    },
  });
  const throwing = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("trap");
      },
    },
  );
  const inherited = Object.create({ data: { data: { id: sessionId } } });
  for (const value of [null, [], accessor, throwing, inherited, { unexpected: true }]) {
    expect(classifyOpenCode118DirectSessionPresence(value, sessionId)).toBe("unknown");
  }
  expect(reads).toBe(0);
});

test("checks abort again after a direct read settles", async () => {
  const controller = new AbortController();
  const port = createDirectParticipantPresencePort({
    async get() {
      controller.abort();
      return { data: { data: { id: sessionId } }, response: response(200) };
    },
  });
  expect(await port.readParticipantPresence(sessionId, controller.signal)).toBe("unknown");
});
