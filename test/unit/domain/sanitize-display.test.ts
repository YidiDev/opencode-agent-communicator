import { describe, expect, test } from "bun:test";

import { sanitizeDisplayTitle } from "../../../src/domain/sanitize-display";

describe("display-title terminal safety", () => {
  test("strips ESC and C1 CSI sequences", () => {
    expect(sanitizeDisplayTitle("A\u001b[31;1mred\u001b[0mB\u009b32mgreen")).toBe("AredBgreen");
  });

  test("strips OSC terminated by BEL or ST", () => {
    expect(
      sanitizeDisplayTitle("A\u001b]0;forged title\u0007B\u001b]8;;https://unsafe\u001b\\C"),
    ).toBe("ABC");
  });

  test("strips DCS terminated by ST", () => {
    expect(sanitizeDisplayTitle("A\u001bP1;2|private payload\u001b\\B")).toBe("AB");
  });

  test("strips standalone C0 and C1 controls", () => {
    expect(sanitizeDisplayTitle("A\u0000\n\u007f\u0085B")).toBe("AB");
  });

  test("strips bidi embeddings, overrides, marks, and isolates", () => {
    expect(
      sanitizeDisplayTitle("A\u061c\u200e\u200f\u202aL\u202c\u202eR\u202c\u2066I\u2069B"),
    ).toBe("ALRIB");
  });

  test("retains supplementary Unicode and ordinary text", () => {
    expect(sanitizeDisplayTitle("Session café 東京 🧪🚀")).toBe("Session café 東京 🧪🚀");
  });

  test("fails safe for malformed or unterminated terminal sequences", () => {
    expect(sanitizeDisplayTitle("safe\u001b[12;")).toBe("safe");
    expect(sanitizeDisplayTitle("safe\u001b]unterminated")).toBe("safe");
    expect(sanitizeDisplayTitle("safe\u001bPunterminated")).toBe("safe");
    expect(sanitizeDisplayTitle("safe\u001bztext")).toBe("safetext");
  });
});
