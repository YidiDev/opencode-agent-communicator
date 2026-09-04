import { describe, expect, test } from "bun:test";

import {
  BoundedJsonFault,
  BoundedJsonParser,
} from "../../../../src/adapters/export/bounded-json-parser";
import { NativeExportStreamValidator } from "../../../../src/adapters/export/native-export-stream-validation";
import { validateNativeExport } from "../../../../src/adapters/export/native-export-validation";
import { nativeJsonHardLimits } from "../../../../src/adapters/export/native-json-limits";

const sessionId = "ses_export" as never;

function nativeExport(messages: unknown[] = []): Record<string, unknown> {
  return {
    info: {
      id: sessionId,
      slug: "session",
      projectID: "project",
      title: `[redacted:session-title:${sessionId}]`,
      directory: `[redacted:session-directory:${sessionId}]`,
      version: "1.18.25",
      time: { created: 1, updated: 2 },
    },
    messages,
  };
}

function message(parts: unknown[] = []): Record<string, unknown> {
  return {
    info: {
      id: "msg_1",
      sessionID: sessionId,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts,
  };
}

function textPart(index: number): Record<string, unknown> {
  return {
    id: `part_${index}`,
    sessionID: sessionId,
    messageID: "msg_1",
    type: "text",
    text: "x",
  };
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function expectParserLimit(json: string): void {
  const parser = new BoundedJsonParser();
  expect(() => {
    parser.feed(json);
    parser.finish();
  }).toThrow(BoundedJsonFault);
}

function parseJsonChunks(...chunks: string[]): unknown {
  const parser = new BoundedJsonParser();
  for (const chunk of chunks) parser.feed(chunk);
  return parser.finish();
}

function expectMalformed(json: string): void {
  expect(() => parseJsonChunks(json)).toThrow(BoundedJsonFault);
}

describe("bounded incremental native export validation", () => {
  test("accepts UTF-8 and escapes split at every byte boundary", () => {
    const value = nativeExport();
    (value.info as Record<string, unknown>).metadata = { note: 'é\\"𐀀' };
    const bytes = encode(value);
    const validator = new NativeExportStreamValidator({
      sessionId,
      isSanitized: true,
      deadlineMs: Number.MAX_SAFE_INTEGER,
    });
    for (const byte of bytes) validator.feed(new Uint8Array([byte]));
    expect(validator.finish()).toEqual({ ok: true });
  });

  test("enforces the exact nesting ceiling and rejects one level beyond it", () => {
    const atLimit = nativeExport();
    let cursor: Record<string, unknown> = {};
    (atLimit.info as Record<string, unknown>).metadata = cursor;
    for (let depth = 3; depth < nativeJsonHardLimits.maximumNestingDepth; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    expect(validateNativeExport(encode(atLimit), sessionId, true)).toEqual({ ok: true });
    cursor.child = {};
    expect(validateNativeExport(encode(atLimit), sessionId, true)).toEqual({
      ok: false,
      reason: "limit",
    });
  });

  test("enforces message and aggregate part cardinality at their boundaries", () => {
    const oneMessage = message();
    expect(
      validateNativeExport(
        encode(nativeExport(Array(nativeJsonHardLimits.maximumMessages).fill(oneMessage))),
        sessionId,
        true,
      ),
    ).toEqual({ ok: true });
    expect(
      validateNativeExport(
        encode(nativeExport(Array(nativeJsonHardLimits.maximumMessages + 1).fill(oneMessage))),
        sessionId,
        true,
      ),
    ).toEqual({ ok: false, reason: "limit" });

    const parts = Array.from({ length: nativeJsonHardLimits.maximumParts }, (_, index) =>
      textPart(index),
    );
    expect(validateNativeExport(encode(nativeExport([message(parts)])), sessionId, true)).toEqual({
      ok: true,
    });
    parts.push(textPart(parts.length));
    expect(validateNativeExport(encode(nativeExport([message(parts)])), sessionId, true)).toEqual({
      ok: false,
      reason: "limit",
    });
  });

  test("bounds individual and aggregate strings plus aggregate nodes and keys", () => {
    const atStringLimit = nativeExport();
    (atStringLimit.info as Record<string, unknown>).metadata = {
      value: "x".repeat(nativeJsonHardLimits.maximumStringCharacters),
    };
    expect(validateNativeExport(encode(atStringLimit), sessionId, true)).toEqual({ ok: true });
    ((atStringLimit.info as Record<string, unknown>).metadata as Record<string, unknown>).value =
      "x".repeat(nativeJsonHardLimits.maximumStringCharacters + 1);
    expect(validateNativeExport(encode(atStringLimit), sessionId, true)).toEqual({
      ok: false,
      reason: "limit",
    });

    expectParserLimit(`[${Array(nativeJsonHardLimits.maximumNodes).fill("null").join(",")}]`);
    expectParserLimit(
      `{${Array.from(
        { length: nativeJsonHardLimits.maximumKeys + 1 },
        (_, index) => `"k${index}":null`,
      ).join(",")}}`,
    );
    expectParserLimit(
      `[${Array(nativeJsonHardLimits.maximumStrings + 1)
        .fill('""')
        .join(",")}]`,
    );
    const maximumString = "x".repeat(nativeJsonHardLimits.maximumStringCharacters);
    expectParserLimit(
      `[${Array(
        Math.floor(
          nativeJsonHardLimits.maximumAggregateStringCharacters /
            nativeJsonHardLimits.maximumStringCharacters,
        ) + 1,
      )
        .fill(`"${maximumString}"`)
        .join(",")}]`,
    );
  });

  test("stops parser work at a deadline between bounded decode slices", () => {
    let checks = 0;
    const validator = new NativeExportStreamValidator({
      sessionId,
      isSanitized: true,
      deadlineMs: 1,
      now: () => (checks++ === 0 ? 0 : 2),
    });
    validator.feed(encode({ padding: "x".repeat(70_000) }));
    expect(validator.finish()).toEqual({ ok: false, reason: "deadline" });
  });

  test("rejects malformed incremental token, separator, escape, and number states", () => {
    expect(parseJsonChunks(" \t\n\r", '[true,false,null,-1.5e+2,{"a":1,"b":2}]')).toEqual([
      true,
      false,
      null,
      -150,
      { a: 1, b: 2 },
    ]);
    expect(parseJsonChunks('"\\/\\b\\f\\n\\r\\t\\u0041"')).toBe("/\b\f\n\r\tA");
    expect(parseJsonChunks("1")).toBe(1);
    expect(parseJsonChunks("true")).toBe(true);

    for (const malformed of [
      "",
      '"unterminated',
      "null null",
      "?",
      "{x:1}",
      '{"a" 1}',
      '{"a":1?}',
      "[1?]",
      "[1,]",
      '{"a":1,}',
      '"control\u0001"',
      '"\\x"',
      '"\\u00xz"',
      "truX",
      "01",
    ]) {
      expectMalformed(malformed);
    }
    expectMalformed("1".repeat(nativeJsonHardLimits.maximumNumberCharacters + 1));
  });

  test("retains the first streaming failure and checks an otherwise idle final deadline", () => {
    const malformed = new NativeExportStreamValidator({
      sessionId,
      isSanitized: true,
      deadlineMs: Number.MAX_SAFE_INTEGER,
    });
    malformed.feed(new TextEncoder().encode('"\\x"'));
    malformed.feed(encode(nativeExport()));
    expect(malformed.finish()).toEqual({ ok: false, reason: "malformed" });

    const expired = new NativeExportStreamValidator({
      sessionId,
      isSanitized: true,
      deadlineMs: 1,
      now: () => 1,
    });
    expect(expired.finish()).toEqual({ ok: false, reason: "deadline" });
  });
});
