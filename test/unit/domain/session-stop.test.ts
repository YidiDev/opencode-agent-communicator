import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  digestSessionStopReason,
  sessionStopReasonMaximumBytes,
  validateSessionStopReason,
} from "../../../src/domain/session-stop";

const digest = {
  async sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHash("sha256").update(bytes).digest());
  },
};

describe("session stop reason", () => {
  test("validates exact UTF-8 bounds and unsafe controls", () => {
    expect(validateSessionStopReason(undefined)).toMatchObject({ ok: true });
    expect(validateSessionStopReason("")).toMatchObject({ ok: false });
    expect(validateSessionStopReason("reason\0spoof")).toMatchObject({ ok: false });
    expect(validateSessionStopReason("reason\u202espoof")).toMatchObject({ ok: false });
    expect(validateSessionStopReason(`reason${String.fromCharCode(0xd800)}`)).toMatchObject({
      ok: false,
    });
    expect(validateSessionStopReason(`reason${String.fromCharCode(0xd800)}x`)).toMatchObject({
      ok: false,
    });
    expect(validateSessionStopReason(`reason${String.fromCharCode(0xdc00)}`)).toMatchObject({
      ok: false,
    });
    expect(validateSessionStopReason("é".repeat(sessionStopReasonMaximumBytes / 2))).toMatchObject({
      ok: true,
    });
    expect(
      validateSessionStopReason(`é${"a".repeat(sessionStopReasonMaximumBytes - 1)}`),
    ).toMatchObject({ ok: false });
  });

  test("digests tagged absence separately from exact supplied content", async () => {
    const absent = validateSessionStopReason(undefined);
    const supplied = validateSessionStopReason("deploy complete");
    if (!absent.ok || !supplied.ok) throw new Error("invalid fixture");
    const absentDigest = await digestSessionStopReason(digest, absent);
    const suppliedDigest = await digestSessionStopReason(digest, supplied);
    expect(absentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(suppliedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(absentDigest).not.toBe(suppliedDigest);
    expect(await digestSessionStopReason(digest, supplied)).toBe(suppliedDigest);
  });

  test("rejects malformed digest adapter output", async () => {
    const reason = validateSessionStopReason("bounded");
    if (!reason.ok) throw new Error("invalid fixture");
    await expect(
      digestSessionStopReason({ sha256: async () => new Uint8Array(31) }, reason),
    ).rejects.toThrow("malformed");
  });
});
