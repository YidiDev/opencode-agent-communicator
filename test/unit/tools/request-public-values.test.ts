import { expect, test } from "bun:test";

import type {
  ParticipantRequestGet,
  ParticipantRequestMetadata,
} from "../../../src/application/request-ports";
import { validateRequestId } from "../../../src/domain/generated-ids";
import { validateSessionId } from "../../../src/domain/sessions";
import { publicParticipantRequest, publicRequestMetadata } from "../../../src/tools/public-values";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const requestId = valid(validateRequestId(`req_${"a".repeat(32)}`));
const source = valid(validateSessionId("ses_source"));
const target = valid(validateSessionId("ses_target"));
const pendingMetadata: ParticipantRequestMetadata<"target"> = {
  requestId,
  participantRole: "target",
  kind: "ask",
  resolutionState: "pending",
  deliveryState: "admitted",
  resultState: "none",
  sourceSessionId: source,
  targetSessionId: target,
  createdAtMs: 10,
  updatedAtMs: 12,
  deadlineAtMs: 40,
  submittedAtMs: 11,
  admittedAtMs: 12,
};

test("projects payload-free request metadata with exact snake_case timestamps", () => {
  expect(publicRequestMetadata(pendingMetadata)).toEqual({
    request_id: requestId,
    role: "target",
    kind: "ask",
    resolution_state: "pending",
    delivery_state: "admitted",
    result_state: "none",
    source_session_id: source,
    target_session_id: target,
    created_at_ms: 10,
    updated_at_ms: 12,
    deadline_at_ms: 40,
    acknowledgement_applicable: false,
    submitted_at_ms: 11,
    admitted_at_ms: 12,
  });
  const serialized = JSON.stringify(publicRequestMetadata(pendingMetadata));
  expect(serialized).not.toContain("workspace");
  expect(serialized).not.toContain("sha256");
  expect(serialized).not.toContain("native_message");
  expect(serialized).not.toContain("payload");
});

test("projects pending ask payloads using only public snake_case content", () => {
  type PendingAskGet = Extract<
    ParticipantRequestGet,
    { readonly outcome: "pending_payload"; readonly payload: { readonly kind: "ask" } }
  >;
  const found: PendingAskGet = {
    outcome: "pending_payload",
    metadata: pendingMetadata as PendingAskGet["metadata"],
    payload: {
      kind: "ask",
      questions: [{ prompt: "Choose", options: ["one"], multiple: false, allowCustom: true }],
      timeoutSeconds: 30,
    },
  };
  expect(publicParticipantRequest(found)).toEqual({
    outcome: "pending_payload",
    metadata: publicRequestMetadata(pendingMetadata),
    payload: {
      kind: "ask",
      questions: [{ prompt: "Choose", options: ["one"], multiple: false, allow_custom: true }],
      timeout_seconds: 30,
    },
  });
});

test("projects retained wait results and source acknowledgement metadata", () => {
  const metadata = {
    ...pendingMetadata,
    participantRole: "source",
    kind: "wait",
    resolutionState: "reached",
    resultState: "available",
    resolvedAtMs: 20,
    resultAvailableAtMs: 20,
    resultExpiresAtMs: 30,
  } as Extract<
    ParticipantRequestGet,
    { readonly outcome: "available_result"; readonly result: { readonly kind: "wait" } }
  >["metadata"];
  const found: ParticipantRequestGet = {
    outcome: "available_result",
    metadata,
    result: { kind: "wait", evidence: "artifact" },
  };
  expect(publicParticipantRequest(found)).toMatchObject({
    outcome: "available_result",
    metadata: {
      role: "source",
      resolution_state: "reached",
      result_state: "available",
      acknowledgement_applicable: true,
      resolved_at_ms: 20,
      result_available_at_ms: 20,
      result_expires_at_ms: 30,
    },
    result: { kind: "wait", evidence: "artifact" },
  });
});
