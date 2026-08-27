import { describe, expect, test } from "bun:test";

import {
  createSessionExportPolicy,
  validateExportDestination,
} from "../../../src/domain/session-export";

describe("session export domain", () => {
  test("accepts bounded portable relative destinations", () => {
    expect(validateExportDestination("team/session.json")).toMatchObject({
      ok: true,
      components: ["team", "session.json"],
    });
    expect(validateExportDestination("exports/a;b $(touch nope).json").ok).toBe(true);
    expect(validateExportDestination(`${"é".repeat(127)}/x`).ok).toBe(true);
  });

  test("rejects absolute, traversal, empty, control, separator, and byte-hostile paths", () => {
    for (const value of [
      "",
      "/tmp/x",
      "C:/tmp/x",
      "\\server\\x",
      "../x",
      "a/../x",
      "./x",
      "a//x",
      "a/",
      "a\\x",
      "a\0x",
      "a\nx",
      `a${String.fromCodePoint(0x202e)}x`,
      "x".repeat(1_025),
      `${"é".repeat(128)}/x`,
      `${Array.from({ length: 33 }, () => "x").join("/")}`,
    ]) {
      expect(validateExportDestination(value).ok).toBe(false);
    }
  });

  test("reserves the stale-stage cleanup namespace in every path component", () => {
    const reserved = `.session-export-${"a".repeat(32)}.stage`;
    expect(validateExportDestination(".session-export-staging/result.json").ok).toBe(false);
    expect(validateExportDestination(reserved).ok).toBe(false);
    expect(validateExportDestination(`nested/${reserved}/result.json`).ok).toBe(false);
    expect(validateExportDestination(`${reserved}.json`).ok).toBe(true);
    expect(validateExportDestination(`.session-export-${"g".repeat(32)}.stage`).ok).toBe(true);
  });

  test("ships secure policy defaults and rejects malformed policy", () => {
    expect(createSessionExportPolicy()).toEqual({
      selfSanitized: "allow",
      crossSession: "ask",
      unsanitized: "ask",
      overwrite: "ask",
    });
    expect(() => createSessionExportPolicy({ overwrite: "other" as never })).toThrow();
  });
});
