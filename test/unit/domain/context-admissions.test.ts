import { expect, test } from "bun:test";

import {
  canTransitionContextAdmission,
  isCoherentContextAdmission,
} from "../../../src/domain/context-admissions";
import { validateDeliveryId, validateRequestId } from "../../../src/domain/generated-ids";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const base = {
  id: valid(validateDeliveryId(`dlv_${"c".repeat(32)}`)),
  kind: "message" as const,
  workspaceKey: valid(validateWorkspaceKey("context-domain")),
  sourceSessionId: valid(validateSessionId("ses_source")),
  targetSessionId: valid(validateSessionId("ses_target")),
  contentByteLength: 1,
  contentSha256: "d".repeat(64),
  createdAtMs: 10,
};

const fixtures = {
  prepared: { ...base, state: "prepared", updatedAtMs: 10 },
  awaiting_context: {
    ...base,
    state: "awaiting_context",
    updatedAtMs: 20,
    awaitingContextAtMs: 20,
  },
  context_admitted: {
    ...base,
    state: "context_admitted",
    updatedAtMs: 30,
    awaitingContextAtMs: 20,
    contextAdmittedAtMs: 30,
    claimedFencingToken: 1,
  },
  failed: { ...base, state: "failed", updatedAtMs: 20, failedAtMs: 20 },
  cancelled: { ...base, state: "cancelled", updatedAtMs: 20, cancelledAtMs: 20 },
} as const;

test("accepts every coherent state and the request identity variant", () => {
  for (const fixture of Object.values(fixtures))
    expect(isCoherentContextAdmission(fixture)).toBe(true);
  expect(
    isCoherentContextAdmission({
      ...fixtures.prepared,
      id: valid(validateRequestId(`req_${"e".repeat(32)}`)),
      kind: "request",
    }),
  ).toBe(true);
});

test("transition table only permits prepared and awaiting progress", () => {
  expect(canTransitionContextAdmission("prepared", "awaiting_context")).toBe(true);
  expect(canTransitionContextAdmission("prepared", "failed")).toBe(true);
  expect(canTransitionContextAdmission("prepared", "cancelled")).toBe(true);
  expect(canTransitionContextAdmission("awaiting_context", "context_admitted")).toBe(true);
  expect(canTransitionContextAdmission("context_admitted", "failed")).toBe(false);
  expect(canTransitionContextAdmission("failed", "cancelled")).toBe(false);
  expect(canTransitionContextAdmission("cancelled", "prepared")).toBe(false);
});

test("rejects malformed identity and content boundaries", () => {
  for (const value of [undefined, null, [], "record"])
    expect(isCoherentContextAdmission(value)).toBe(false);
  for (const patch of [
    { kind: "other" },
    { state: "other" },
    { id: "bad" },
    { id: valid(validateRequestId(`req_${"f".repeat(32)}`)) },
    { workspaceKey: "" },
    { sourceSessionId: "bad" },
    { targetSessionId: "bad" },
    { targetSessionId: base.sourceSessionId },
    { contentByteLength: 0 },
    { contentByteLength: 65_537 },
    { contentByteLength: 1.5 },
    { contentSha256: 3 },
    { contentSha256: "A".repeat(64) },
    { createdAtMs: -1 },
    { updatedAtMs: Number.NaN },
    { updatedAtMs: 9 },
  ]) {
    expect(isCoherentContextAdmission({ ...fixtures.prepared, ...patch })).toBe(false);
  }
});

test("rejects absent, stale, future, and contradictory lifecycle timestamps", () => {
  for (const value of [
    { ...fixtures.prepared, awaitingContextAtMs: 10 },
    { ...fixtures.awaiting_context, awaitingContextAtMs: undefined },
    { ...fixtures.awaiting_context, awaitingContextAtMs: 9 },
    { ...fixtures.awaiting_context, awaitingContextAtMs: 21 },
    { ...fixtures.context_admitted, contextAdmittedAtMs: undefined },
    { ...fixtures.context_admitted, contextAdmittedAtMs: 31 },
    { ...fixtures.prepared, contextAdmittedAtMs: 10 },
    { ...fixtures.failed, failedAtMs: undefined },
    { ...fixtures.failed, failedAtMs: 21 },
    { ...fixtures.prepared, failedAtMs: 10 },
    { ...fixtures.cancelled, cancelledAtMs: undefined },
    { ...fixtures.cancelled, cancelledAtMs: 21 },
    { ...fixtures.prepared, cancelledAtMs: 10 },
    { ...fixtures.failed, updatedAtMs: 30, awaitingContextAtMs: 25 },
    { ...fixtures.context_admitted, claimedFencingToken: undefined },
    { ...fixtures.context_admitted, claimedFencingToken: 0 },
    { ...fixtures.prepared, claimedFencingToken: 1 },
  ]) {
    expect(isCoherentContextAdmission(value)).toBe(false);
  }
});
