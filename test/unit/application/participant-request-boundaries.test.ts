import { expect, test } from "bun:test";

import { inspectParticipantRequestMetadata } from "../../../src/application/participant-request-boundaries";

const base = {
  requestId: `req_${"a".repeat(32)}`,
  participantRole: "source",
  kind: "ask",
  sourceSessionId: "ses_source",
  targetSessionId: "ses_target",
  resolutionState: "answered",
  deliveryState: "admitted",
  resultState: "available",
  createdAtMs: 1,
  updatedAtMs: 4,
  deadlineAtMs: 10,
  resolvedAtMs: 4,
  submittedAtMs: 2,
  admittedAtMs: 3,
  resultAvailableAtMs: 4,
  resultExpiresAtMs: 20,
} as const;

test("validates optional participant timestamps independently of property order", () => {
  const { resolvedAtMs: _resolvedAtMs, ...withoutResolved } = base;
  const reordered = {
    resolvedAtMs: "bad",
    ...withoutResolved,
  };
  expect(inspectParticipantRequestMetadata(reordered)).toBeUndefined();
  expect(inspectParticipantRequestMetadata({ ...base })).toMatchObject({
    resultState: "available",
    resultAvailableAtMs: 4,
  });
});

test("enforces available and acknowledged result lifecycle correlations", () => {
  expect(
    inspectParticipantRequestMetadata({
      ...base,
      resultState: "expired",
      resultExpiredAtMs: 20,
    }),
  ).toMatchObject({ resultState: "expired" });
  expect(
    inspectParticipantRequestMetadata({
      ...base,
      resultExpiredAtMs: 20,
    }),
  ).toBeUndefined();
  expect(
    inspectParticipantRequestMetadata({
      ...base,
      resultState: "acknowledged",
      resultExpiredAtMs: 20,
      acknowledgedAtMs: 21,
    }),
  ).toMatchObject({ resultState: "acknowledged" });
});
