import { expect, test } from "bun:test";

import { inspectParticipantRequestMetadata } from "../../../src/application/participant-request-boundaries";
import { inspectExpiredRequestBatch } from "../../../src/application/request-expiry-boundary";
import {
  inspectParticipantObservation,
  inspectRequestMetadata,
} from "../../../src/application/request-recovery-boundaries";
import type { FencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture, requestTestWorkspace } from "../../support/request-store";

const token = 1 as FencingToken;

function participantBase(request: RequestMetadata): Record<string, unknown> {
  return {
    requestId: request.id,
    participantRole: "source",
    kind: request.kind,
    sourceSessionId: request.sourceSessionId,
    targetSessionId: request.targetSessionId,
    resolutionState: "pending",
    deliveryState: "prepared",
    resultState: "none",
    createdAtMs: request.createdAtMs,
    updatedAtMs: request.updatedAtMs,
    deadlineAtMs: request.deadlineAtMs,
  };
}

test("participant metadata accepts each delivery lifecycle and rejects missing correlated timestamps", async () => {
  const request = (await requestFixture(token)).request;
  const pending = participantBase(request);
  expect(inspectParticipantRequestMetadata(pending)).toMatchObject({ deliveryState: "prepared" });

  const submitting = {
    ...pending,
    deliveryState: "submitting",
    submittedAtMs: request.createdAtMs + 1,
    updatedAtMs: request.createdAtMs + 1,
  };
  expect(inspectParticipantRequestMetadata(submitting)).toMatchObject({
    deliveryState: "submitting",
  });
  expect(
    inspectParticipantRequestMetadata({
      ...submitting,
      deliveryState: "delivery_unknown",
    }),
  ).toBeUndefined();
  expect(
    inspectParticipantRequestMetadata({
      ...submitting,
      deliveryState: "promoted",
      admittedAtMs: request.createdAtMs + 2,
    }),
  ).toBeUndefined();
  expect(
    inspectParticipantRequestMetadata({
      ...submitting,
      deliveryState: "delivery_failed",
    }),
  ).toBeUndefined();
});

test("participant result lifecycle rejects missing retention, acknowledgement, and expiry correlations", async () => {
  const request = (await requestFixture(token)).request;
  const answered = {
    ...participantBase(request),
    kind: "ask",
    resolutionState: "answered",
    deliveryState: "admitted",
    resultState: "available",
    submittedAtMs: request.createdAtMs + 1,
    admittedAtMs: request.createdAtMs + 2,
    resolvedAtMs: request.createdAtMs + 3,
    updatedAtMs: request.createdAtMs + 3,
  };
  expect(inspectParticipantRequestMetadata(answered)).toBeUndefined();
  expect(
    inspectParticipantRequestMetadata({
      ...answered,
      resultAvailableAtMs: request.createdAtMs + 3,
      resultExpiresAtMs: request.createdAtMs + 4,
      resultState: "acknowledged",
    }),
  ).toBeUndefined();
  expect(
    inspectParticipantRequestMetadata({
      ...answered,
      resultAvailableAtMs: request.createdAtMs + 3,
      resultExpiresAtMs: request.createdAtMs + 4,
      resultExpiredAtMs: request.createdAtMs + 3,
      resultState: "expired",
    }),
  ).toBeUndefined();
});

test("recovery snapshots reject incomplete metadata and malformed admission evidence", async () => {
  const request = (await requestFixture(token)).request;
  const { payloadByteLength: _missing, ...incomplete } = request;
  expect(inspectRequestMetadata(incomplete)).toBeUndefined();
  expect(
    inspectRequestMetadata({
      ...request,
      admissionEvidence: {
        state: "admitted",
        nativeMessageId: request.nativeMessageId,
        admittedSeq: 1,
        observedAtMs: 2,
        extra: true,
      },
    }),
  ).toBeUndefined();
  expect(
    inspectParticipantObservation({ sourceVisible: true, targetVisible: true }),
  ).toBeUndefined();
});

test("expired batch boundary rejects malformed containers and incoherent rows without mutating seen", async () => {
  const workspaceKey = requestTestWorkspace();
  const seen = new Set<never>();
  expect(
    inspectExpiredRequestBatch({ value: null, workspaceKey, seen, batchLimit: 10, hardLimit: 10 }),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  const request = (await requestFixture(token)).request;
  expect(
    inspectExpiredRequestBatch({
      value: { ok: true, requests: [request] },
      workspaceKey,
      seen,
      batchLimit: 10,
      hardLimit: 10,
    }),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  expect(seen.size).toBe(0);
});
