import { describe, expect, test } from "bun:test";

import { sanitizeDisplayTitle } from "../../../src/domain/sanitize-display";
import { sessionIdPolicy, validateSessionId } from "../../../src/domain/sessions";

describe("session domain boundaries", () => {
  test("accepts normal generated and bounded host-canonical session IDs", () => {
    const normalGenerated = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(normalGenerated.slice(sessionIdPolicy.prefix.length)).toHaveLength(
      sessionIdPolicy.normalGeneratedPayloadLength,
    );
    const valid = validateSessionId(normalGenerated);
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(String(valid.value)).toBe(normalGenerated);
    expect(validateSessionId("ses_hostCanonical123").ok).toBe(true);
  });

  test.each([
    ["wrong prefix", "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    ["empty payload", "ses_"],
    ["control", "ses_safe\u001b[31m"],
    ["path slash", "ses_../../secret"],
    ["path separator", "ses_tmp/session"],
    ["dash", "ses_bad-id"],
    ["non-ASCII", "ses_会話"],
    ["overlong", `ses_${"a".repeat(sessionIdPolicy.maximumHostPayloadLength + 1)}`],
  ])("rejects %s session IDs", (_label, value) => {
    expect(validateSessionId(value).ok).toBe(false);
  });

  test("rejects non-string session IDs", () => {
    expect(validateSessionId(12).ok).toBe(false);
  });

  test("rejects a huge session ID before pattern validation", () => {
    expect(validateSessionId(`ses_${"a".repeat(10_000_000)}`)).toEqual({
      ok: false,
      message: "Session ID is malformed.",
    });
  });

  test("strips ANSI, terminal string, C0/C1, and bidi controls from titles", () => {
    const unsafe = [
      "safe",
      "\u001b[31mred\u001b[0m",
      "\u001b]0;terminal title\u0007visible",
      "\u001bPprivate\u001b\\text",
      "\u009b32mgreen",
      "\n\u0000\u007f\u009f\u009c",
      "\u061c\u200e\u200f\u202eRTL\u202c\u2066isolate\u2069\u206a",
    ].join("");
    expect(sanitizeDisplayTitle(unsafe)).toBe("saferedvisibletextgreenRTLisolate");
  });

  test("retains ordinary Unicode display text", () => {
    expect(sanitizeDisplayTitle("Review café 東京 🚀")).toBe("Review café 東京 🚀");
  });

  test("fails safe for unterminated and single-character terminal controls", () => {
    expect(sanitizeDisplayTitle("before\u001b[123;")).toBe("before");
    expect(sanitizeDisplayTitle("before\u001b]unterminated")).toBe("before");
    expect(sanitizeDisplayTitle("before\u001bzafter")).toBe("beforeafter");
  });
});
