import { describe, expect, test } from "bun:test";

import type { MessageRecoveryPorts } from "../../../src/application/delivery-ports";
import {
  interpretRecoveredMessageAdmission,
  recoverOnePreparedMessage,
} from "../../../src/application/recover-one-prepared-message";
import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateFencingToken } from "../../../src/domain/ownership";
import { domainFailure } from "../../../src/domain/results";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid recovery fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:admission-result"));
const fencingToken = value(validateFencingToken(53));
const prepared: DeliveryMetadata = {
  id: value(validateDeliveryId(`dlv_${"a".repeat(32)}`)),
  workspaceKey,
  sourceSessionId: value(validateSessionId("ses_source")),
  targetSessionId: value(validateSessionId("ses_target")),
  nativeMessageId: value(validateNativeMessageId(`msg_${"b".repeat(32)}`)),
  state: "prepared",
  contentByteLength: 2,
  contentSha256: "c".repeat(64) as Sha256Digest,
  createdAtMs: 1,
  updatedAtMs: 1,
};

describe("prepared message admission result", () => {
  test("accepts only durable unknown and failed domain outcomes", () => {
    for (const code of ["admission_unknown", "admission_failed"] as const) {
      expect(
        interpretRecoveredMessageAdmission(domainFailure(code, "durably classified", false)),
      ).toEqual({ ok: true, value: "submitted" });
    }
    for (const code of [
      "quota_exceeded",
      "rate_limited",
      "native_unavailable",
      "ownership_lost",
      "state_conflict",
      "storage_unavailable",
      "invalid_arguments",
    ] as const) {
      expect(
        interpretRecoveredMessageAdmission(domainFailure(code, "not durable", false)),
      ).toMatchObject({ ok: false, error: { code } });
    }
  });

  for (const code of ["quota_exceeded", "rate_limited"] as const) {
    test(`propagates ${code} after claim without reporting the current-token strand ready`, async () => {
      let current: DeliveryMetadata = prepared;
      let claimedToken: number | undefined;
      const ports = {
        deliveries: {
          async claimPrepared() {
            current = { ...prepared, state: "submitting", submittedAtMs: 2, updatedAtMs: 2 };
            claimedToken = fencingToken;
            return { ok: true as const, delivery: current, envelope: "{}" };
          },
          async completeSubmission() {
            return { ok: false as const, code };
          },
        },
        membership: {
          async readCurrentRoots() {
            return { sourceVisible: true, targetVisible: true, sourceTitle: "source" };
          },
        },
        nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
        ownership: { acquire: async () => fencingToken, isCurrent: async () => true },
        clock: { nowMs: () => 2 },
      } as unknown as MessageRecoveryPorts;

      const result = await recoverOnePreparedMessage(
        ports,
        workspaceKey,
        fencingToken,
        new AbortController().signal,
        undefined,
        prepared,
      );
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(current.state).toBe("submitting");
      expect(claimedToken).toBe(fencingToken);
    });
  }
});
