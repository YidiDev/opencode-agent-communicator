import { describe, expect, test } from "bun:test";

import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { domainFailure } from "../../../src/domain/results";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import {
  serializeDomainResult,
  sessionDeliveryGetArgumentsSchema,
  sessionDeliveryGetFailureCodes,
  sessionListArgumentsSchema,
  sessionListFailureCodes,
  sessionReadArgumentsSchema,
  sessionReadFailureCodes,
  sessionSendArgumentsSchema,
  sessionSendFailureCodes,
  ToolContractFault,
} from "../../../src/tools/contracts";
import { publicDelivery, publicParticipantDelivery } from "../../../src/tools/public-values";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

describe("internal session tool contracts", () => {
  test("uses strict canonical argument schemas", () => {
    expect(sessionListArgumentsSchema.safeParse({ status: "active", limit: 1 }).success).toBe(true);
    expect(
      sessionListArgumentsSchema.safeParse({ include_archived: true, limit: 100 }).success,
    ).toBe(true);
    expect(sessionListArgumentsSchema.safeParse({ status: "busy" }).success).toBe(false);
    expect(sessionListArgumentsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(sessionListArgumentsSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(sessionListArgumentsSchema.safeParse({ extra: true }).success).toBe(false);
    expect(sessionReadArgumentsSchema.parse({ session_id: "ses_target" }).limit).toBe(100);
    expect(
      sessionReadArgumentsSchema.safeParse({ session_id: "ses_target", direction: "before" })
        .success,
    ).toBe(false);

    expect(
      sessionSendArgumentsSchema.safeParse({ session_id: "ses_target", content: "hi" }).success,
    ).toBe(true);
    expect(
      sessionSendArgumentsSchema.safeParse({ session_id: "ses_target", content: "hi", extra: 1 })
        .success,
    ).toBe(false);
    expect(
      sessionDeliveryGetArgumentsSchema.safeParse({ delivery_id: `dlv_${"a".repeat(32)}` }).success,
    ).toBe(true);
    expect(sessionDeliveryGetArgumentsSchema.safeParse({ delivery_id: 1 }).success).toBe(false);
    for (const delivery_id of [
      "dlv_value",
      `dlv_${"A".repeat(32)}`,
      `dlv_${"a".repeat(31)}`,
      `other_${"a".repeat(32)}`,
    ]) {
      expect(sessionDeliveryGetArgumentsSchema.safeParse({ delivery_id }).success).toBe(false);
    }
    expect(
      sessionSendArgumentsSchema.safeParse({ session_id: "ses_HostCanonical123", content: "hi" })
        .success,
    ).toBe(true);
    expect(
      sessionSendArgumentsSchema.safeParse({ session_id: `ses_${"a".repeat(124)}`, content: "hi" })
        .success,
    ).toBe(true);
    for (const session_id of ["malformed", "ses_bad-control\u0000", `ses_${"a".repeat(125)}`]) {
      expect(sessionSendArgumentsSchema.safeParse({ session_id, content: "hi" }).success).toBe(
        false,
      );
    }
    const exactMultibyteContent = "é".repeat(16 * 1024);
    expect(new TextEncoder().encode(exactMultibyteContent)).toHaveLength(32 * 1024);
    expect(
      sessionSendArgumentsSchema.safeParse({
        session_id: "ses_target",
        content: exactMultibyteContent,
      }).success,
    ).toBe(true);
    const overLimitMultibyteContent = `${exactMultibyteContent}é`;
    expect(new TextEncoder().encode(overLimitMultibyteContent)).toHaveLength(32 * 1024 + 2);
    expect(
      sessionSendArgumentsSchema.safeParse({
        session_id: "ses_target",
        content: overLimitMultibyteContent,
      }).success,
    ).toBe(false);
  });

  test("declares the exact application failure-code supersets beside schemas", () => {
    expect(sessionListFailureCodes).toEqual([
      "invalid_arguments",
      "caller_not_visible",
      "deadline_expired",
      "native_unavailable",
    ]);
    expect(sessionReadFailureCodes).toEqual([
      "invalid_arguments",
      "caller_not_visible",
      "target_not_visible",
      "permission_denied",
      "approval_rejected",
      "deadline_expired",
      "native_unavailable",
      "cursor_stale",
    ]);
    expect(new Set(sessionSendFailureCodes)).toEqual(
      new Set([
        "invalid_arguments",
        "caller_not_visible",
        "target_not_visible",
        "target_idle",
        "target_status_unknown",
        "permission_denied",
        "approval_rejected",
        "deadline_expired",
        "quota_exceeded",
        "rate_limited",
        "state_conflict",
        "native_unavailable",
        "admission_failed",
        "admission_unknown",
        "ownership_lost",
        "storage_unavailable",
      ]),
    );
    expect(sessionDeliveryGetFailureCodes).toEqual([
      "invalid_arguments",
      "not_found_or_unauthorized",
      "caller_not_visible",
      "deadline_expired",
      "native_unavailable",
      "ownership_lost",
      "storage_unavailable",
    ]);
    const unsafe = domainFailure("unsafe_path", "private original message", false, {
      secret: "private details",
    });
    let fault: unknown;
    try {
      serializeDomainResult(unsafe, String, sessionListFailureCodes);
    } catch (cause: unknown) {
      fault = cause;
    }
    expect(fault).toBeInstanceOf(ToolContractFault);
    expect(fault).toEqual(new ToolContractFault());
    expect(JSON.stringify(fault)).not.toContain("private original message");
    expect(JSON.stringify(fault)).not.toContain("private details");
  });

  test("serializes payload-free public delivery metadata with no workspace or digest", () => {
    const sourceSessionId = valid(validateSessionId("ses_source"));
    const targetSessionId = valid(validateSessionId("ses_target"));
    const nativeMessageId = valid(validateNativeMessageId(`msg_${"b".repeat(32)}`));
    const delivery: DeliveryMetadata = {
      id: valid(validateDeliveryId(`dlv_${"a".repeat(32)}`)),
      workspaceKey: valid(validateWorkspaceKey("workspace:one")),
      sourceSessionId,
      targetSessionId,
      nativeMessageId,
      state: "admitted",
      contentByteLength: 2,
      contentSha256: "c".repeat(64) as Sha256Digest,
      createdAtMs: 1,
      updatedAtMs: 2,
      submittedAtMs: 2,
      admittedAtMs: 2,
      admissionEvidence: {
        nativeMessageId,
        state: "admitted",
        admittedSeq: 3,
        observedAtMs: 2,
      },
    };
    const value = publicDelivery(delivery);
    expect(value).toMatchObject({
      delivery_id: `dlv_${"a".repeat(32)}`,
      source_session_id: "ses_source",
      target_session_id: "ses_target",
      state: "admitted",
      admission_evidence: { admitted_seq: 3, observed_at_ms: 2 },
    });
    expect(value).not.toHaveProperty("workspaceKey");
    expect(value).not.toHaveProperty("workspace_key");
    expect(value).not.toHaveProperty("contentSha256");
    expect(JSON.stringify(value)).not.toContain("payload");
    expect(publicParticipantDelivery({ role: "source", transport: "user", delivery })).toEqual({
      role: "source",
      delivery: { ...value, delivery: "user" },
    });
  });
});

describe("public delivery values", () => {
  test("serializes exact optional metadata for every delivery state", () => {
    const sourceSessionId = valid(validateSessionId("ses_source"));
    const targetSessionId = valid(validateSessionId("ses_target"));
    const nativeMessageId = valid(validateNativeMessageId(`msg_${"b".repeat(32)}`));
    const base = {
      id: valid(validateDeliveryId(`dlv_${"a".repeat(32)}`)),
      workspaceKey: valid(validateWorkspaceKey("workspace:one")),
      sourceSessionId,
      targetSessionId,
      nativeMessageId,
      contentByteLength: 2,
      contentSha256: "c".repeat(64) as Sha256Digest,
      createdAtMs: 1,
      updatedAtMs: 7,
    };
    const states: ReadonlyArray<{
      readonly delivery: DeliveryMetadata;
      readonly expected: Record<string, unknown>;
    }> = [
      { delivery: { ...base, state: "prepared" }, expected: {} },
      {
        delivery: { ...base, state: "submitting", submittedAtMs: 2 },
        expected: { submitted_at_ms: 2 },
      },
      {
        delivery: {
          ...base,
          state: "admission_unknown",
          submittedAtMs: 2,
          admissionUnknownAtMs: 3,
        },
        expected: { submitted_at_ms: 2, admission_unknown_at_ms: 3 },
      },
      {
        delivery: {
          ...base,
          state: "admitted",
          submittedAtMs: 2,
          admittedAtMs: 3,
          admissionEvidence: {
            nativeMessageId,
            state: "admitted",
            admittedSeq: 4,
            observedAtMs: 3,
          },
        },
        expected: {
          submitted_at_ms: 2,
          admitted_at_ms: 3,
          admission_evidence: {
            native_message_id: nativeMessageId,
            state: "admitted",
            admitted_seq: 4,
            observed_at_ms: 3,
          },
        },
      },
      {
        delivery: {
          ...base,
          state: "promoted",
          submittedAtMs: 2,
          admittedAtMs: 3,
          promotedAtMs: 4,
          admissionEvidence: {
            nativeMessageId,
            state: "promoted",
            admittedSeq: 4,
            promotedSeq: 5,
            observedAtMs: 4,
          },
        },
        expected: {
          submitted_at_ms: 2,
          admitted_at_ms: 3,
          promoted_at_ms: 4,
          admission_evidence: {
            native_message_id: nativeMessageId,
            state: "promoted",
            admitted_seq: 4,
            promoted_seq: 5,
            observed_at_ms: 4,
          },
        },
      },
      {
        delivery: { ...base, state: "failed", submittedAtMs: 2, failedAtMs: 3 },
        expected: { submitted_at_ms: 2, failed_at_ms: 3 },
      },
      {
        delivery: { ...base, state: "cancelled", cancelledAtMs: 2 },
        expected: { cancelled_at_ms: 2 },
      },
    ];
    for (const { delivery, expected } of states) {
      const serialized = publicDelivery(delivery);
      expect(serialized).toMatchObject({ state: delivery.state, ...expected });
      expect(serialized).not.toHaveProperty("payload");
      expect(serialized).not.toHaveProperty("content_sha256");
      expect(serialized).not.toHaveProperty("contentSha256");
      expect(serialized).not.toHaveProperty("workspace_key");
      expect(serialized).not.toHaveProperty("workspaceKey");
      const optionalKeys = [
        "submitted_at_ms",
        "admission_unknown_at_ms",
        "admitted_at_ms",
        "promoted_at_ms",
        "failed_at_ms",
        "cancelled_at_ms",
        "admission_evidence",
      ];
      expect(optionalKeys.filter((key) => key in serialized).sort()).toEqual(
        Object.keys(expected).sort(),
      );
    }
  });
});
