import { describe, expect, test } from "bun:test";

import { isSubmissionTerminalState } from "../../../src/application/delivery-ports";
import {
  canTransitionDelivery,
  type DeliveryMetadata,
  type DeliveryState,
  deliveryStates,
  isCoherentDeliveryMetadata,
} from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const base: DeliveryMetadata = {
  id: value(validateDeliveryId(`dlv_${"1".repeat(32)}`)),
  workspaceKey: value(validateWorkspaceKey("workspace:delivery")),
  sourceSessionId: value(validateSessionId("ses_source")),
  targetSessionId: value(validateSessionId("ses_target")),
  nativeMessageId: value(validateNativeMessageId(`msg_${"2".repeat(32)}`)),
  state: "prepared",
  contentByteLength: 1,
  contentSha256: "a".repeat(64) as Sha256Digest,
  createdAtMs: 1,
  updatedAtMs: 1,
};

describe("message delivery state machine", () => {
  test("allows exactly the Phase 1 monotonic transitions", () => {
    const allowed = new Set([
      "prepared->submitting",
      "prepared->cancelled",
      "submitting->admitted",
      "submitting->admission_unknown",
      "submitting->failed",
      "admission_unknown->admitted",
      "admission_unknown->promoted",
      "admission_unknown->failed",
      "admitted->promoted",
    ]);
    for (const from of deliveryStates) {
      for (const to of deliveryStates) {
        expect(canTransitionDelivery(from, to), `${from}->${to}`).toBe(
          allowed.has(`${from}->${to}`),
        );
      }
    }
  });

  test("contains no inferred started state", () => {
    expect(deliveryStates).not.toContain("started" as DeliveryState);
  });

  test("classifies only submission outcomes as terminal for admission", () => {
    expect(deliveryStates.filter(isSubmissionTerminalState)).toEqual([
      "admission_unknown",
      "admitted",
      "promoted",
      "failed",
    ]);
  });

  test("strictly validates state-required timestamps, digest, and native evidence", () => {
    expect(isCoherentDeliveryMetadata(base)).toBe(true);
    expect(isCoherentDeliveryMetadata({ ...base, contentSha256: "BAD" as Sha256Digest })).toBe(
      false,
    );
    expect(isCoherentDeliveryMetadata({ ...base, createdAtMs: Number.NaN })).toBe(false);
    expect(
      isCoherentDeliveryMetadata({
        ...base,
        state: "submitting",
        submittedAtMs: 2,
        updatedAtMs: 2,
      }),
    ).toBe(true);
    expect(
      isCoherentDeliveryMetadata({
        ...base,
        state: "admission_unknown",
        submittedAtMs: 2,
        admissionUnknownAtMs: 3,
        updatedAtMs: 3,
      }),
    ).toBe(true);
    expect(
      isCoherentDeliveryMetadata({
        ...base,
        state: "failed",
        submittedAtMs: 2,
        failedAtMs: 3,
        updatedAtMs: 3,
      }),
    ).toBe(true);
    expect(
      isCoherentDeliveryMetadata({ ...base, state: "cancelled", cancelledAtMs: 2, updatedAtMs: 2 }),
    ).toBe(true);
    const admitted: DeliveryMetadata = {
      ...base,
      state: "admitted",
      submittedAtMs: 2,
      admittedAtMs: 3,
      updatedAtMs: 3,
      admissionEvidence: {
        nativeMessageId: base.nativeMessageId,
        state: "admitted",
        admittedSeq: 4,
        observedAtMs: 3,
      },
    };
    expect(isCoherentDeliveryMetadata(admitted)).toBe(true);
    expect(
      isCoherentDeliveryMetadata({
        ...admitted,
        admissionEvidence: {
          nativeMessageId: base.nativeMessageId,
          state: "admitted",
          admittedSeq: 4,
          observedAtMs: Number.POSITIVE_INFINITY,
        },
      }),
    ).toBe(false);
    const promoted: DeliveryMetadata = {
      ...admitted,
      state: "promoted",
      promotedAtMs: 4,
      updatedAtMs: 4,
      admissionEvidence: {
        nativeMessageId: base.nativeMessageId,
        state: "promoted",
        admittedSeq: 4,
        promotedSeq: 5,
        observedAtMs: 4,
      },
    };
    expect(isCoherentDeliveryMetadata(promoted)).toBe(true);
    expect(
      isCoherentDeliveryMetadata({
        ...promoted,
        admissionEvidence: {
          nativeMessageId: base.nativeMessageId,
          state: "promoted",
          admittedSeq: 4,
          promotedSeq: 4,
          observedAtMs: 4,
        },
      }),
    ).toBe(false);
    const staleEvidence = {
      nativeMessageId: base.nativeMessageId,
      state: "admitted" as const,
      admittedSeq: 4,
      observedAtMs: 3,
    };
    const adversarialExtras: readonly DeliveryMetadata[] = [
      { ...base, admissionEvidence: staleEvidence },
      {
        ...base,
        state: "cancelled",
        updatedAtMs: 2,
        cancelledAtMs: 2,
        admissionEvidence: staleEvidence,
      },
      {
        ...base,
        state: "submitting",
        updatedAtMs: 2,
        submittedAtMs: 2,
        admissionEvidence: staleEvidence,
      },
      {
        ...base,
        state: "admission_unknown",
        updatedAtMs: 3,
        submittedAtMs: 2,
        admissionUnknownAtMs: 3,
        admissionEvidence: staleEvidence,
      },
      {
        ...base,
        state: "failed",
        updatedAtMs: 3,
        submittedAtMs: 2,
        failedAtMs: 3,
        admissionEvidence: staleEvidence,
      },
      { ...admitted, updatedAtMs: 4, promotedAtMs: 4 },
      { ...promoted, updatedAtMs: 5, failedAtMs: 5 },
    ];
    for (const delivery of adversarialExtras) {
      expect(isCoherentDeliveryMetadata(delivery), delivery.state).toBe(false);
    }
    for (const observedAtMs of [0, admitted.updatedAtMs + 1, Number.POSITIVE_INFINITY]) {
      expect(
        isCoherentDeliveryMetadata({
          ...admitted,
          admissionEvidence: { ...staleEvidence, observedAtMs },
        }),
      ).toBe(false);
    }
  });
});
