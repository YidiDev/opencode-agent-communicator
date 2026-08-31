import { describe, expect, test } from "bun:test";

import type { ContextAdmissionMetadata } from "../../../src/domain/context-admissions";
import { validateAdvisoryLockId, validateDeliveryId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import {
  publicAdvisoryLock,
  publicAdvisoryLockList,
  publicMessageDelivery,
  publicParticipantDelivery,
} from "../../../src/tools/public-values";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const base: ContextAdmissionMetadata = {
  id: valid(validateDeliveryId(`dlv_${"f".repeat(32)}`)),
  kind: "message",
  workspaceKey: valid(validateWorkspaceKey("workspace:public-context")),
  sourceSessionId: valid(validateSessionId("ses_source")),
  targetSessionId: valid(validateSessionId("ses_target")),
  state: "awaiting_context",
  contentByteLength: 42,
  contentSha256: "a".repeat(64) as Sha256Digest,
  createdAtMs: 10,
  updatedAtMs: 11,
  awaitingContextAtMs: 11,
};

describe("public context delivery values", () => {
  test.each([
    [base, { awaiting_context_at_ms: 11 }],
    [
      {
        ...base,
        state: "context_admitted",
        updatedAtMs: 12,
        contextAdmittedAtMs: 12,
      } as ContextAdmissionMetadata,
      { awaiting_context_at_ms: 11, context_admitted_at_ms: 12 },
    ],
    [
      { ...base, state: "failed", updatedAtMs: 12, failedAtMs: 12 } as ContextAdmissionMetadata,
      { awaiting_context_at_ms: 11, failed_at_ms: 12 },
    ],
    [
      {
        ...base,
        state: "cancelled",
        updatedAtMs: 12,
        cancelledAtMs: 12,
      } as ContextAdmissionMetadata,
      { awaiting_context_at_ms: 11, cancelled_at_ms: 12 },
    ],
    [
      (() => {
        const { awaitingContextAtMs: _awaitingContextAtMs, ...prepared } = base;
        return {
          ...prepared,
          state: "prepared",
        } as ContextAdmissionMetadata;
      })(),
      {},
    ],
  ] as const)("serializes optional state timestamps for %#", (delivery, optionals) => {
    const value = publicMessageDelivery(delivery);
    expect(value).toMatchObject({
      delivery_id: base.id,
      source_session_id: base.sourceSessionId,
      target_session_id: base.targetSessionId,
      delivery: "context",
      state: delivery.state,
      content_byte_length: 42,
      created_at_ms: 10,
      updated_at_ms: delivery.updatedAtMs,
      ...optionals,
    });
    expect(JSON.stringify(value)).not.toContain("workspace");
    expect(JSON.stringify(value)).not.toContain("sha256");
  });

  test("includes context transport in participant delivery projection", () => {
    expect(
      publicParticipantDelivery({ role: "target", transport: "context", delivery: base }),
    ).toEqual({
      role: "target",
      delivery: publicMessageDelivery(base),
    });
  });

  test("serializes advisory-lock pagination branches", () => {
    const lock = {
      lockId: valid(validateAdvisoryLockId(`lck_${"a".repeat(32)}`)),
      holderSessionId: valid(validateSessionId("ses_holder")),
      title: "title",
      description: "description",
      instructions: "instructions",
      createdAtMs: 0,
      renewedAtMs: 1,
      expiresAtMs: 2,
    } as const;
    expect(publicAdvisoryLockList({ locks: [lock], nextCursor: "cursor" })).toEqual({
      locks: [publicAdvisoryLock(lock)],
      next_cursor: "cursor",
    });
    expect(publicAdvisoryLockList({ locks: [] })).toEqual({ locks: [] });
  });

  test.each([-1, Number.MAX_SAFE_INTEGER + 1, 8_640_000_000_000_001])(
    "rejects unsafe advisory-lock timestamp %s",
    (createdAtMs) => {
      expect(() =>
        publicAdvisoryLock({
          lockId: `lck_${"a".repeat(32)}` as never,
          holderSessionId: valid(validateSessionId("ses_holder")),
          title: "title",
          description: "description",
          instructions: "instructions",
          createdAtMs,
          renewedAtMs: 1,
          expiresAtMs: 2,
        }),
      ).toThrow(TypeError);
    },
  );
});
