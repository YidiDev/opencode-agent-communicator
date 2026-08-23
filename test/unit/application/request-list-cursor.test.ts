import { describe, expect, test } from "bun:test";

import {
  encodeRequestListCursor,
  parseRequestListCursor,
} from "../../../src/application/request-list-cursor";
import { validateRequestId } from "../../../src/domain/generated-ids";

const validated = validateRequestId(`req_${"a".repeat(32)}`);
if (!validated.ok) throw new Error(validated.message);
const boundary = { createdAtMs: 42, requestId: validated.value };

function raw(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("request list cursor", () => {
  test("round trips the canonical exact boundary and binds role", () => {
    const cursor = encodeRequestListCursor("inbox", boundary);
    expect(parseRequestListCursor(cursor, "inbox")).toEqual({ ok: true, boundary });
    expect(parseRequestListCursor(cursor, "outbox")).toEqual({
      ok: false,
      message: "cursor is malformed or does not match the requested role.",
    });
    expect(cursor).not.toContain("=");
  });

  test.each([
    "",
    "%%",
    "e30=",
    raw(null),
    raw([]),
    raw({ v: 2, role: "inbox", createdAtMs: 42, requestId: boundary.requestId }),
    raw({ v: 1, role: "inbox", createdAtMs: -1, requestId: boundary.requestId }),
    raw({ v: 1, role: "inbox", createdAtMs: 1.5, requestId: boundary.requestId }),
    raw({ v: 1, role: "inbox", createdAtMs: 42, requestId: "req_bad" }),
    raw({ role: "inbox", v: 1, createdAtMs: 42, requestId: boundary.requestId }),
    raw({ v: 1, role: "inbox", createdAtMs: 42, requestId: boundary.requestId, extra: true }),
  ])("rejects malformed, noncanonical, mistyped, or extended cursor %#", (cursor) => {
    expect(parseRequestListCursor(cursor, "inbox").ok).toBe(false);
  });

  test("rejects invalid encoding boundaries", () => {
    expect(() => encodeRequestListCursor("all", { ...boundary, createdAtMs: -1 })).toThrow();
    expect(parseRequestListCursor("a".repeat(513), "all").ok).toBe(false);
  });
});
