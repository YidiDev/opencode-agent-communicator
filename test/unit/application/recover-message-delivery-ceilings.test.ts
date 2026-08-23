import { describe, expect, test } from "bun:test";

import {
  classifyStaleMessageDeliveries,
  recoverPreparedMessageDeliveries,
} from "../../../src/application/recover-message-deliveries";
import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}
const workspaceKey = valid(validateWorkspaceKey("workspace:recovery-ceiling"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const fencingToken = valid(validateFencingToken(17));

function metadata(index: number, state: "prepared" | "submitting"): DeliveryMetadata {
  const suffix = index.toString(16).padStart(32, "0");
  return {
    id: valid(validateDeliveryId(`dlv_${suffix}`)),
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId: valid(validateNativeMessageId(`msg_${suffix}`)),
    state,
    contentByteLength: 1,
    contentSha256: "f".repeat(64) as Sha256Digest,
    createdAtMs: index,
    updatedAtMs: index,
    ...(state === "submitting" ? { submittedAtMs: index } : {}),
  };
}

const phase = {
  workspaceKey,
  fencingToken,
  startupBarrier: { established: true as const, fencingToken },
  abort: new AbortController().signal,
  limit: 100,
};

describe("delivery recovery hard ceilings", () => {
  test("drains 50000 stale deliveries and proves exhaustion", async () => {
    let offset = 0;
    let changed = 0;
    const ports = {
      deliveries: {
        async listRecoverable(input: { limit: number }) {
          if (offset === 50_000) return [];
          const count = Math.min(input.limit, 50_000 - offset);
          const page = Array.from({ length: count }, (_, index) =>
            metadata(offset + index + 1, "submitting"),
          );
          offset += count;
          return page;
        },
        async completeSubmission(input: { deliveryId: string }) {
          changed += 1;
          const original = metadata(Number.parseInt(input.deliveryId.slice(4), 16), "submitting");
          return {
            ok: true,
            delivery: {
              ...original,
              state: "admission_unknown",
              admissionUnknownAtMs: 60_000,
              updatedAtMs: 60_000,
            },
          };
        },
      },
      ownership: { isCurrent: async () => true },
      clock: { nowMs: () => 60_000 },
    } as never;
    expect(await classifyStaleMessageDeliveries(ports, phase)).toEqual({ ok: true, value: 50_000 });
    expect(changed).toBe(50_000);
  });

  test("keysets and cancels 50000 prepared deliveries before success", async () => {
    let cancelled = 0;
    const ports = {
      deliveries: {
        async listRecoverable(input: { limit: number; cursor?: { createdAtMs: number } }) {
          if (cancelled === 50_000) return [];
          const offset = input.cursor?.createdAtMs ?? 0;
          if (offset === 50_000) return [];
          const count = Math.min(input.limit, 50_000 - offset);
          return Array.from({ length: count }, (_, index) =>
            metadata(offset + index + 1, "prepared"),
          );
        },
        async cancelPrepared(input: { deliveryId: string }) {
          cancelled += 1;
          const original = metadata(Number.parseInt(input.deliveryId.slice(4), 16), "prepared");
          return {
            ok: true,
            delivery: {
              ...original,
              state: "cancelled",
              cancelledAtMs: 60_000,
              updatedAtMs: 60_000,
            },
          };
        },
      },
      membership: {
        readCurrentRoots: async () => ({
          sourceTitle: "source",
          sourceVisible: true,
          targetVisible: false,
        }),
      },
      ownership: { isCurrent: async () => true },
      clock: { nowMs: () => 60_000 },
    } as never;
    expect(await recoverPreparedMessageDeliveries(ports, phase)).toEqual({
      ok: true,
      value: { submitted: 0, cancelled: 50_000 },
    });
    expect(cancelled).toBe(50_000);
  });
});
