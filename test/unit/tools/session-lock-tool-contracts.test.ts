import { describe, expect, test } from "bun:test";
import { validateAdvisoryLockId } from "../../../src/domain/generated-ids";
import { validateSessionId } from "../../../src/domain/sessions";
import {
  sessionLockListArgumentsSchema,
  sessionLockOwnedMutationFailureCodes,
  sessionLockPublishArgumentsSchema,
  sessionLockPublishFailureCodes,
  sessionLockReleaseArgumentsSchema,
  sessionLockRenewArgumentsSchema,
} from "../../../src/tools/contracts";
import { publicAdvisoryLock, publicAdvisoryLockMutation } from "../../../src/tools/public-values";

function value<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("Invalid fixture.");
  return result.value;
}

describe("session lock tool contracts", () => {
  test("uses exact strict canonical schemas and UTF-8 byte limits", () => {
    const lock_id = `lck_${"a".repeat(32)}`;
    expect(sessionLockListArgumentsSchema.parse({})).toEqual({ limit: 50 });
    expect(sessionLockListArgumentsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(sessionLockListArgumentsSchema.safeParse({ cursor: "bad=" }).success).toBe(false);
    expect(sessionLockListArgumentsSchema.safeParse({ extra: true }).success).toBe(false);
    expect(sessionLockReleaseArgumentsSchema.safeParse({ lock_id }).success).toBe(true);
    expect(
      sessionLockReleaseArgumentsSchema.safeParse({ lock_id, holder: "ses_spoof" }).success,
    ).toBe(false);
    expect(sessionLockRenewArgumentsSchema.safeParse({ lock_id, ttl_seconds: 3600 }).success).toBe(
      true,
    );
    expect(sessionLockRenewArgumentsSchema.safeParse({ lock_id, ttl_seconds: 0 }).success).toBe(
      false,
    );
    const valid = { ttl_seconds: 1, title: "t", description: "d", instructions: "i" };
    expect(sessionLockPublishArgumentsSchema.safeParse(valid).success).toBe(true);
    expect(sessionLockPublishArgumentsSchema.safeParse({ ...valid, description: "" }).success).toBe(
      false,
    );
    expect(
      sessionLockPublishArgumentsSchema.safeParse({ ...valid, title: "é".repeat(513) }).success,
    ).toBe(false);
    expect(
      sessionLockPublishArgumentsSchema.safeParse({ ...valid, holder_session_id: "ses_spoof" })
        .success,
    ).toBe(false);
  });

  test("declares mutation failures without native notification failures", () => {
    expect(sessionLockPublishFailureCodes).toEqual([
      "invalid_arguments",
      "caller_not_visible",
      "quota_exceeded",
      "ownership_lost",
      "storage_unavailable",
    ]);
    expect(sessionLockOwnedMutationFailureCodes).toContain("not_found_or_unauthorized");
    expect(sessionLockPublishFailureCodes).not.toContain("native_unavailable" as never);
  });

  test("serializes only public lock fields with canonical UTC dates", () => {
    const lock = {
      lockId: value(validateAdvisoryLockId(`lck_${"a".repeat(32)}`)),
      holderSessionId: value(validateSessionId("ses_holder")),
      title: "Lock",
      description: "Description",
      instructions: "Instructions",
      createdAtMs: 0,
      renewedAtMs: 1_000,
      expiresAtMs: 2_000,
    };
    expect(publicAdvisoryLock(lock)).toEqual({
      lock_id: lock.lockId,
      held_by_session_id: "ses_holder",
      title: "Lock",
      description: "Description",
      instructions: "Instructions",
      created_at: "1970-01-01T00:00:00.000Z",
      renewed_at: "1970-01-01T00:00:01.000Z",
      expires_at: "1970-01-01T00:00:02.000Z",
    });
    const mutation = publicAdvisoryLockMutation({
      lock,
      notification: { eligible: 0, admitted: 0, unknown: 0 },
    });
    expect(JSON.stringify(mutation)).not.toContain("workspace");
    expect(JSON.stringify(mutation)).not.toContain("AtMs");
    expect(JSON.stringify(mutation)).not.toContain("fencing");
  });
});
