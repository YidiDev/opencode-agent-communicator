import { describe, expect, test } from "bun:test";

import {
  isCoherentAdvisoryLock,
  validateAdvisoryLockDescription,
  validateAdvisoryLockInstructions,
  validateAdvisoryLockTitle,
  validateAdvisoryLockTtlSeconds,
} from "../../../src/domain/advisory-locks";

describe("advisory lock domain", () => {
  test("enforces UTF-8 byte limits rather than UTF-16 length", () => {
    expect(validateAdvisoryLockTitle("x".repeat(1_024)).ok).toBe(true);
    expect(validateAdvisoryLockTitle("😀".repeat(256)).ok).toBe(true);
    expect(validateAdvisoryLockTitle(`x${"😀".repeat(256)}`).ok).toBe(false);
    expect(validateAdvisoryLockTitle("").ok).toBe(false);
    expect(validateAdvisoryLockDescription("😀".repeat(2_048)).ok).toBe(true);
    expect(validateAdvisoryLockDescription(`x${"😀".repeat(2_048)}`).ok).toBe(false);
    expect(validateAdvisoryLockInstructions("😀".repeat(4_096)).ok).toBe(true);
    expect(validateAdvisoryLockInstructions(`x${"😀".repeat(4_096)}`).ok).toBe(false);
  });

  test("accepts only integral TTLs from 1 through 3600", () => {
    for (const valid of [1, 3_600]) expect(validateAdvisoryLockTtlSeconds(valid).ok).toBe(true);
    for (const invalid of [0, 3_601, 1.5, Number.NaN, "10"]) {
      expect(validateAdvisoryLockTtlSeconds(invalid).ok).toBe(false);
    }
  });

  test("recognizes only coherent generated identity, holder, and timestamp ordering", () => {
    const lock = {
      lockId: `lck_${"a".repeat(32)}`,
      holderSessionId: "ses_holder",
      title: "Database migration",
      description: "Coordinates schema work.",
      instructions: "Release after verification.",
      createdAtMs: 10,
      renewedAtMs: 10,
      expiresAtMs: 11,
    };
    expect(isCoherentAdvisoryLock(lock)).toBe(true);
    expect(isCoherentAdvisoryLock({ ...lock, expiresAtMs: 10 })).toBe(false);
    expect(isCoherentAdvisoryLock({ ...lock, lockId: `lck_${"A".repeat(32)}` })).toBe(false);
  });
});
