import { describe, expect, test } from "bun:test";

import { digestMessageContent, type Sha256Digest } from "../../../src/domain/message-payload";
import { sessionReadLimits } from "../../../src/domain/session-read";
import {
  decodeSessionReadCursor,
  encodeSessionReadCursor,
} from "../../../src/domain/session-read-cursor";
import { validateSessionId } from "../../../src/domain/sessions";

async function digest(byte: number): Promise<Sha256Digest> {
  return digestMessageContent(
    { sha256: async () => new Uint8Array(32).fill(byte) },
    new Uint8Array(),
  );
}

function session(value: string) {
  const result = validateSessionId(value);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function noncanonicalBase64Url(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const remainder = Buffer.from(value, "base64url").length % 3;
  const unusedBits = remainder === 1 ? 4 : 2;
  const final = alphabet.indexOf(value.at(-1) ?? "");
  if (final < 0 || remainder === 0) throw new Error("Fixture has no mutable base64url tail.");
  const replacement = alphabet[((final >> unusedBits) << unusedBits) | 1];
  if (replacement === undefined) throw new Error("Fixture tail could not be replaced.");
  return `${value.slice(0, -1)}${replacement}`;
}

const workspace = await digest(0xaa);
const otherWorkspace = await digest(0xcc);
const prefixSha256 = await digest(0xbb);

describe("session read cursor", () => {
  const sessionId = session("ses_reader1");
  const boundary = {
    messageId: "msg-1",
    itemKey: "part:1",
    utf8ByteOffset: 42,
    prefixSha256,
  };

  test("round trips a bounded canonical cursor with exact field order", () => {
    const cursor = encodeSessionReadCursor(workspace, sessionId, boundary);
    expect(cursor.length).toBeLessThan(sessionReadLimits.maxCursorCharacters);
    expect(decodeSessionReadCursor(cursor, workspace, sessionId)).toEqual({ ok: true, boundary });
    const decoded = Buffer.from(cursor, "base64url").toString();
    expect(decoded).toBe(
      `{"v":1,"w":"${workspace}","s":"${sessionId}","m":"msg-1","k":"part:1","o":42,"p":"${boundary.prefixSha256}"}`,
    );
  });

  test("rejects wrong workspace, session, and projection version distinctly", () => {
    const cursor = encodeSessionReadCursor(workspace, sessionId, boundary);
    expect(decodeSessionReadCursor(cursor, otherWorkspace, sessionId)).toMatchObject({
      ok: false,
      reason: "workspace_mismatch",
    });
    expect(decodeSessionReadCursor(cursor, workspace, session("ses_other1"))).toMatchObject({
      ok: false,
      reason: "session_mismatch",
    });
    const wrongVersion = rawCursor({
      v: 2,
      w: workspace,
      s: sessionId,
      m: "msg-1",
      k: "part:1",
      o: 42,
      p: boundary.prefixSha256,
    });
    expect(decodeSessionReadCursor(wrongVersion, workspace, sessionId)).toMatchObject({
      ok: false,
      reason: "version_mismatch",
    });
  });

  test("rejects malformed, oversized, reordered, padded, and noncanonical values", () => {
    const reordered = rawCursor({
      w: workspace,
      v: 1,
      s: sessionId,
      m: "msg-1",
      k: "part:1",
      o: 42,
      p: boundary.prefixSha256,
    });
    const negative = rawCursor({
      v: 1,
      w: workspace,
      s: sessionId,
      m: "msg-1",
      k: "part:1",
      o: -1,
      p: boundary.prefixSha256,
    });
    for (const cursor of [
      "%%%",
      "a".repeat(sessionReadLimits.maxCursorCharacters + 1),
      reordered,
      negative,
      `${encodeSessionReadCursor(workspace, sessionId, boundary)}=`,
      rawCursor(null),
    ]) {
      expect(decodeSessionReadCursor(cursor, workspace, sessionId)).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("rejects a noncanonical base64url spelling without reflecting malformed input", () => {
    let canonical = encodeSessionReadCursor(workspace, sessionId, boundary);
    while (Buffer.from(canonical, "base64url").length % 3 === 0) {
      canonical = encodeSessionReadCursor(workspace, sessionId, {
        ...boundary,
        itemKey: `${boundary.itemKey}x`,
      });
    }
    const noncanonical = noncanonicalBase64Url(canonical);
    expect(Buffer.from(noncanonical, "base64url")).toEqual(Buffer.from(canonical, "base64url"));
    expect(decodeSessionReadCursor(noncanonical, workspace, sessionId)).toEqual({
      ok: false,
      reason: "malformed",
      message: "cursor is malformed or does not match this session read.",
    });

    const reflectedSecret = "secret-cursor-value";
    const malformed = decodeSessionReadCursor(reflectedSecret, workspace, sessionId);
    expect(malformed).toMatchObject({ ok: false, reason: "malformed" });
    expect(JSON.stringify(malformed)).not.toContain(reflectedSecret);
  });

  test("rejects malformed decode bindings and encoded cursors over the immutable size cap", () => {
    const cursor = encodeSessionReadCursor(workspace, sessionId, boundary);
    for (const result of [
      decodeSessionReadCursor(undefined, workspace, sessionId),
      decodeSessionReadCursor("", workspace, sessionId),
      decodeSessionReadCursor(cursor, "not-a-digest" as Sha256Digest, sessionId),
      decodeSessionReadCursor(cursor, workspace, "not-a-session" as never),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: "malformed" });
    }

    expect(() =>
      encodeSessionReadCursor(workspace, sessionId, {
        ...boundary,
        messageId: "m".repeat(sessionReadLimits.maxCursorCharacters),
      }),
    ).toThrow("Session read cursor exceeds its immutable size limit.");
  });

  test("rejects invalid boundaries during encoding", () => {
    expect(() =>
      encodeSessionReadCursor(workspace, sessionId, { ...boundary, utf8ByteOffset: -1 }),
    ).toThrow();
    expect(() =>
      encodeSessionReadCursor(workspace, sessionId, { ...boundary, itemKey: "\n" }),
    ).toThrow();
  });
});
