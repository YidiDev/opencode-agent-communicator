import { expect, test } from "bun:test";
import type { FencingToken } from "../../../src/domain/ownership";
import { requestLimits } from "../../../src/domain/request-constants";
import {
  coherentRequestDelivery,
  coherentRequestResolution,
  coherentRequestResult,
} from "../../../src/domain/request-metadata-state";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function base(): Promise<RequestMetadata> {
  return (await requestFixture(token, 100)).request;
}

test("rejects malformed evidence, context states, and failed-delivery timestamps", async () => {
  const value = await base();
  const submitting = {
    ...value,
    deliveryState: "submitting",
    submittedAtMs: 101,
    updatedAtMs: 110,
  };
  expect(
    coherentRequestDelivery({
      ...submitting,
      deliveryState: "admitted",
      admittedAtMs: 102,
      admissionEvidence: {
        state: "admitted",
        nativeMessageId: value.nativeMessageId,
        admittedSeq: 1,
        observedAtMs: 103,
        extra: true,
      },
    } as never),
  ).toBe(false);
  expect(coherentRequestDelivery({ ...submitting, deliveryMode: "context" } as never)).toBe(false);
  expect(
    coherentRequestDelivery({
      ...submitting,
      deliveryState: "delivery_failed",
      deliveryFailedAtMs: 99,
    } as never),
  ).toBe(false);
  expect(coherentRequestDelivery({ ...submitting, submittedAtMs: 99 } as never)).toBe(false);
});

test("rejects premature acknowledgement and invalid result identities", async () => {
  const value = await base();
  const resolvedAtMs = 200;
  const resultExpiresAtMs = resolvedAtMs + requestLimits.resultRetentionMs;
  const answered = {
    ...value,
    resolutionState: "answered",
    resolvedAtMs,
    updatedAtMs: resultExpiresAtMs,
    resultAvailableAtMs: resolvedAtMs,
    resultExpiresAtMs,
  } as const;
  expect(
    coherentRequestResult({
      ...answered,
      resultState: "available",
      resultByteLength: 0,
      resultSha256: "0".repeat(64),
    } as never),
  ).toBe(false);
  expect(
    coherentRequestResult({
      ...answered,
      resultState: "acknowledged",
      acknowledgedAtMs: 199,
    } as never),
  ).toBe(false);
  expect(
    coherentRequestResolution({ ...value, kind: "wait", resolutionState: "answered" } as never),
  ).toBe(false);
});
