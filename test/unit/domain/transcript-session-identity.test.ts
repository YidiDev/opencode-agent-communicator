import { expect, test } from "bun:test";

import { deriveTranscriptSessionIdentity } from "../../../src/domain/transcript-session-identity";

function message(sessionID = "ses_transcript", id = "msg-1", parts: unknown[] = []) {
  return { info: { sessionID, id }, parts };
}

function part(sessionID = "ses_transcript", messageID = "msg-1") {
  return { type: "text", text: "hello", sessionID, messageID };
}

test("derives one identity across a strict transcript", () => {
  const identity = deriveTranscriptSessionIdentity([
    message("ses_transcript", "msg-1", [part()]),
    message("ses_transcript", "msg-2", [part("ses_transcript", "msg-2")]),
  ]);
  expect(identity.ok).toBe(true);
  if (!identity.ok) throw new Error("valid transcript fixture expected");
  expect(String(identity.sessionId)).toBe("ses_transcript");
  expect(deriveTranscriptSessionIdentity([])).toEqual({ ok: false, reason: "empty" });
});

test("rejects malformed transcript, message, info, and part shapes", () => {
  const inherited = Object.create({});
  const sparse = new Array(1);
  const accessorInfo = Object.defineProperty({}, "sessionID", {
    enumerable: true,
    get: () => "ses_transcript",
  });
  for (const value of [
    null,
    {},
    inherited,
    sparse,
    [null],
    [{ info: null, parts: [] }],
    [{ info: { sessionID: "bad", id: "msg-1" }, parts: [] }],
    [{ info: { sessionID: "ses_transcript", id: "" }, parts: [] }],
    [{ info: accessorInfo, parts: [] }],
    [message("ses_transcript", "msg-1", [null])],
    [message("ses_transcript", "msg-1", [{ sessionID: "bad", messageID: "msg-1" }])],
  ]) {
    expect(deriveTranscriptSessionIdentity(value)).toEqual({ ok: false, reason: "malformed" });
  }
});

test("rejects mixed part ownership and mixed message sessions", () => {
  expect(
    deriveTranscriptSessionIdentity([message("ses_transcript", "msg-1", [part("ses_other")])]),
  ).toEqual({ ok: false, reason: "mixed" });
  expect(
    deriveTranscriptSessionIdentity([
      message("ses_transcript", "msg-1"),
      message("ses_other", "msg-2"),
    ]),
  ).toEqual({ ok: false, reason: "mixed" });
});

test("fails closed when reflective operations throw or limits are exceeded", () => {
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const hostileRecord = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error("hostile");
      },
    },
  );
  const hostileDescriptor = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error("hostile");
      },
    },
  );
  const oversized = Array.from({ length: 10_001 });
  for (const value of [
    revoked.proxy,
    [hostileRecord],
    [{ info: hostileDescriptor, parts: [] }],
    oversized,
  ]) {
    expect(deriveTranscriptSessionIdentity(value)).toMatchObject({ ok: false });
  }
});
