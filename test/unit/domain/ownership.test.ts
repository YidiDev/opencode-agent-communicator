import { describe, expect, test } from "bun:test";

import { validateFencingToken } from "../../../src/domain/ownership";

describe("fencing token", () => {
  test("accepts only opaque positive monotonic safe-integer epochs", () => {
    const token = validateFencingToken(42);
    expect(token).toMatchObject({ ok: true, value: 42 });
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "42"]) {
      expect(validateFencingToken(invalid).ok).toBe(false);
    }
  });
});
