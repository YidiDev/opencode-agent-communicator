import { describe, expect, test } from "bun:test";

import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import { digestMessageContent, type Sha256Digest } from "../../../src/domain/message-payload";
import { requestLimits } from "../../../src/domain/request-constants";
import { isCoherentRequestMetadata } from "../../../src/domain/request-metadata";
import {
  canAcknowledgeRequestResult,
  canAtomicallyAnswerWithAvailableResult,
  canAtomicallyFailPendingRequestDelivery,
  canAtomicallyReachWithAvailableResult,
  canExpireAvailableRequestResult,
} from "../../../src/domain/request-transitions";
import type {
  PendingRequestMetadata,
  RequestMetadataBase,
  RequestResolutionState,
} from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function required<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

async function commonMetadata(): Promise<RequestMetadataBase> {
  return {
    id: required(validateRequestId(`req_${"a".repeat(32)}`)),
    workspaceKey: required(validateWorkspaceKey("workspace:requests")),
    sourceSessionId: required(validateSessionId("ses_source")),
    targetSessionId: required(validateSessionId("ses_target")),
    nativeMessageId: required(validateNativeMessageId(`msg_${"b".repeat(32)}`)),
    payloadByteLength: 100,
    createdAtMs: 100,
    updatedAtMs: 100,
    deadlineAtMs: 1000,
  };
}

async function contentDigest(): Promise<Sha256Digest> {
  return digestMessageContent(
    {
      async sha256() {
        return new Uint8Array(32);
      },
    },
    new Uint8Array([1]),
  );
}

async function pendingAsk(): Promise<PendingRequestMetadata> {
  return {
    ...(await commonMetadata()),
    payloadSha256: await contentDigest(),
    kind: "ask",
    resolutionState: "pending",
    deliveryState: "prepared",
    resultState: "none",
  };
}

function availableResult(
  base: RequestMetadataBase,
  resultSha256: Sha256Digest,
  kind: "ask" | "wait",
  atMs: number,
) {
  return {
    ...base,
    kind,
    resolutionState: kind === "ask" ? "answered" : "reached",
    resolvedAtMs: atMs,
    resultState: "available",
    resultByteLength: 20,
    resultSha256,
    resultAvailableAtMs: atMs,
    resultExpiresAtMs: atMs + requestLimits.resultRetentionMs,
  };
}

const terminalResolutions = [
  "answered",
  "reached",
  "deadline_expired",
  "cancelled",
  "delivery_failed",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
] as const;
const metadataDeliveryStates = [
  "prepared",
  "submitting",
  "delivery_unknown",
  "admitted",
  "promoted",
  "delivery_failed",
] as const;
type TerminalResolution = (typeof terminalResolutions)[number];
type MetadataDeliveryState = (typeof metadataDeliveryStates)[number];

function terminalResultFixture(
  resolutionState: TerminalResolution,
  resolvedAtMs: number,
  digest: Sha256Digest,
): Record<string, unknown> {
  if (resolutionState !== "answered" && resolutionState !== "reached") {
    return { resultState: "none" };
  }
  return {
    resultState: "available",
    resultByteLength: 20,
    resultSha256: digest,
    resultAvailableAtMs: resolvedAtMs,
    resultExpiresAtMs: resolvedAtMs + requestLimits.resultRetentionMs,
  };
}

function deliveryFixture(
  deliveryState: MetadataDeliveryState,
  nativeMessageId: RequestMetadataBase["nativeMessageId"],
  deliveryFailedAtMs: number,
): Record<string, unknown> {
  if (deliveryState === "prepared") return { deliveryState };
  if (deliveryState === "submitting") return { deliveryState, submittedAtMs: 110 };
  if (deliveryState === "delivery_unknown") {
    return { deliveryState, submittedAtMs: 110, deliveryUnknownAtMs: 120 };
  }
  if (deliveryState === "admitted") {
    return {
      deliveryState,
      submittedAtMs: 110,
      admittedAtMs: 120,
      admissionEvidence: { state: "admitted", nativeMessageId, admittedSeq: 4, observedAtMs: 121 },
    };
  }
  if (deliveryState === "promoted") {
    return {
      deliveryState,
      submittedAtMs: 110,
      admittedAtMs: 120,
      promotedAtMs: 121,
      admissionEvidence: {
        state: "promoted",
        nativeMessageId,
        admittedSeq: 4,
        promotedSeq: 5,
        observedAtMs: 121,
      },
    };
  }
  return { deliveryState, submittedAtMs: 110, deliveryFailedAtMs };
}

function expectDeliveryCrossProduct(
  base: RequestMetadataBase,
  digest: Sha256Digest,
  resolutionState: TerminalResolution,
): void {
  const resolvedAtMs = resolutionState === "deadline_expired" ? 1000 : 200;
  const kind = resolutionState === "reached" ? "wait" : "ask";
  const result = terminalResultFixture(resolutionState, resolvedAtMs, digest);
  for (const deliveryState of metadataDeliveryStates) {
    const deliveryFailedAtMs =
      resolutionState === "delivery_failed" ? resolvedAtMs : resolvedAtMs + 10;
    const delivery = deliveryFixture(deliveryState, base.nativeMessageId, deliveryFailedAtMs);
    const updatedAtMs = deliveryState === "delivery_failed" ? deliveryFailedAtMs : resolvedAtMs;
    const metadata = {
      ...base,
      kind,
      resolutionState,
      resolvedAtMs,
      ...result,
      ...delivery,
      updatedAtMs,
    };
    const expected = resolutionState !== "delivery_failed" || deliveryState === "delivery_failed";
    expect(isCoherentRequestMetadata(metadata)).toBe(expected);
    if (expected) {
      expect(isCoherentRequestMetadata({ ...metadata, payloadSha256: digest })).toBe(false);
    }
  }
}

describe("coherent request metadata", () => {
  test("accepts every delivery state and binds admission evidence to the native message", async () => {
    const base = await pendingAsk();
    const nativeMessageId = base.nativeMessageId;
    const deliveries = [
      {},
      { deliveryState: "submitting", submittedAtMs: 110, updatedAtMs: 110 },
      {
        deliveryState: "delivery_unknown",
        submittedAtMs: 110,
        deliveryUnknownAtMs: 120,
        updatedAtMs: 120,
      },
      {
        deliveryState: "admitted",
        submittedAtMs: 110,
        admittedAtMs: 120,
        admissionEvidence: {
          state: "admitted",
          nativeMessageId,
          admittedSeq: 4,
          observedAtMs: 121,
        },
        updatedAtMs: 121,
      },
      {
        deliveryState: "promoted",
        submittedAtMs: 110,
        admittedAtMs: 120,
        promotedAtMs: 120,
        admissionEvidence: {
          state: "promoted",
          nativeMessageId,
          admittedSeq: 4,
          promotedSeq: 5,
          observedAtMs: 121,
        },
        updatedAtMs: 121,
      },
    ];
    for (const delivery of deliveries)
      expect(isCoherentRequestMetadata({ ...base, ...delivery })).toBe(true);
    const admitted = deliveries[3];
    expect(
      isCoherentRequestMetadata({
        ...base,
        ...admitted,
        admissionEvidence: {
          state: "admitted",
          nativeMessageId: required(validateNativeMessageId(`msg_${"c".repeat(32)}`)),
          admittedSeq: 4,
          observedAtMs: 121,
        },
      }),
    ).toBe(false);
    const promoted = deliveries[4];
    expect(
      isCoherentRequestMetadata({
        ...base,
        ...promoted,
        admissionEvidence: {
          state: "promoted",
          nativeMessageId,
          admittedSeq: 5,
          promotedSeq: 5,
          observedAtMs: 121,
        },
      }),
    ).toBe(false);
  });

  test("gives the exact deadline boundary to deadline expiry for every terminal", async () => {
    const base = await commonMetadata();
    const digest = await contentDigest();
    const ordinary: readonly RequestResolutionState[] = [
      "cancelled",
      "target_stopped",
      "source_stopped",
      "target_deleted",
      "source_deleted",
    ];
    for (const resolutionState of ordinary) {
      expect(
        isCoherentRequestMetadata({
          ...base,
          kind: "ask",
          resolutionState,
          resolvedAtMs: 999,
          deliveryState: "prepared",
          resultState: "none",
          updatedAtMs: 999,
        }),
      ).toBe(true);
      expect(
        isCoherentRequestMetadata({
          ...base,
          kind: "ask",
          resolutionState,
          resolvedAtMs: 1000,
          deliveryState: "prepared",
          resultState: "none",
          updatedAtMs: 1000,
        }),
      ).toBe(false);
    }
    for (const kind of ["ask", "wait"] as const) {
      const before = availableResult(base, digest, kind, 999);
      const boundary = availableResult(base, digest, kind, 1000);
      expect(
        isCoherentRequestMetadata({ ...before, deliveryState: "prepared", updatedAtMs: 999 }),
      ).toBe(true);
      expect(
        isCoherentRequestMetadata({ ...boundary, deliveryState: "prepared", updatedAtMs: 1000 }),
      ).toBe(false);
    }
    expect(
      isCoherentRequestMetadata({
        ...base,
        kind: "ask",
        resolutionState: "deadline_expired",
        resolvedAtMs: 999,
        deliveryState: "prepared",
        resultState: "none",
        updatedAtMs: 999,
      }),
    ).toBe(false);
    expect(
      isCoherentRequestMetadata({
        ...base,
        kind: "ask",
        resolutionState: "deadline_expired",
        resolvedAtMs: 1000,
        deliveryState: "prepared",
        resultState: "none",
        updatedAtMs: 1000,
      }),
    ).toBe(true);
    for (const atMs of [999, 1000]) {
      expect(
        isCoherentRequestMetadata({
          ...base,
          kind: "ask",
          resolutionState: "delivery_failed",
          resolvedAtMs: atMs,
          deliveryState: "delivery_failed",
          submittedAtMs: 110,
          deliveryFailedAtMs: atMs,
          resultState: "none",
          updatedAtMs: atMs,
        }),
      ).toBe(atMs < 1000);
    }
  });
});

describe("failed request delivery history", () => {
  test("delivery failure coherence preserves and orders the prior eligible transition", async () => {
    const base = await commonMetadata();
    for (const failedAtMs of [109, 110, 111]) {
      expect(
        isCoherentRequestMetadata({
          ...base,
          kind: "ask",
          resolutionState: "delivery_failed",
          resolvedAtMs: failedAtMs,
          deliveryState: "delivery_failed",
          submittedAtMs: 110,
          deliveryFailedAtMs: failedAtMs,
          resultState: "none",
          updatedAtMs: Math.max(110, failedAtMs),
        }),
      ).toBe(failedAtMs >= 110);
    }
    for (const failedAtMs of [119, 120, 121]) {
      expect(
        isCoherentRequestMetadata({
          ...base,
          kind: "ask",
          resolutionState: "delivery_failed",
          resolvedAtMs: failedAtMs,
          deliveryState: "delivery_failed",
          submittedAtMs: 110,
          deliveryUnknownAtMs: 120,
          deliveryFailedAtMs: failedAtMs,
          resultState: "none",
          updatedAtMs: Math.max(120, failedAtMs),
        }),
      ).toBe(failedAtMs >= 120);
    }
    expect(
      isCoherentRequestMetadata({
        ...base,
        kind: "ask",
        resolutionState: "delivery_failed",
        resolvedAtMs: 120,
        deliveryState: "delivery_failed",
        submittedAtMs: 110,
        deliveryUnknownAtMs: 109,
        deliveryFailedAtMs: 120,
        resultState: "none",
        updatedAtMs: 120,
      }),
    ).toBe(false);
    expect(
      isCoherentRequestMetadata({
        ...base,
        kind: "ask",
        resolutionState: "delivery_failed",
        resolvedAtMs: 120,
        deliveryState: "delivery_failed",
        submittedAtMs: 110,
        deliveryUnknownAtMs: undefined,
        deliveryFailedAtMs: 120,
        resultState: "none",
        updatedAtMs: 120,
      }),
    ).toBe(false);
  });
});

describe("request terminal and delivery aggregate cross-product", () => {
  test("matches the terminal resolution and delivery cross-product", async () => {
    const base = await commonMetadata();
    const digest = await contentDigest();
    for (const resolutionState of terminalResolutions) {
      expectDeliveryCrossProduct(base, digest, resolutionState);
    }
  });
});

describe("request result metadata and semantic transitions", () => {
  test("erases content identity on expiry and acknowledgement", async () => {
    const base = await commonMetadata();
    const digest = await contentDigest();
    const available = {
      ...availableResult(base, digest, "ask", 200),
      deliveryState: "prepared",
      updatedAtMs: 200,
    };
    const expiresAt = 200 + requestLimits.resultRetentionMs;
    expect(isCoherentRequestMetadata(available)).toBe(true);
    const privateExpired = {
      ...base,
      kind: "ask",
      resolutionState: "answered",
      resolvedAtMs: 200,
      deliveryState: "prepared",
      resultState: "expired",
      resultAvailableAtMs: 200,
      resultExpiresAtMs: expiresAt,
      resultExpiredAtMs: expiresAt,
      updatedAtMs: expiresAt,
    };
    expect(isCoherentRequestMetadata(privateExpired)).toBe(true);
    expect(isCoherentRequestMetadata({ ...privateExpired, resultSha256: digest })).toBe(false);
    const acknowledged = {
      ...privateExpired,
      resultState: "acknowledged",
      acknowledgedAtMs: expiresAt + 1,
      updatedAtMs: expiresAt + 1,
    };
    expect(isCoherentRequestMetadata(acknowledged)).toBe(true);
    expect(isCoherentRequestMetadata({ ...acknowledged, resultByteLength: 20 })).toBe(false);
  });

  test("preserves a successful winner when later delivery failure is observed", async () => {
    const base = await commonMetadata();
    const digest = await contentDigest();
    const answered = availableResult(base, digest, "ask", 200);
    for (const delivery of [
      { deliveryState: "prepared" },
      { deliveryState: "submitting", submittedAtMs: 110 },
      {
        deliveryState: "delivery_unknown",
        submittedAtMs: 110,
        deliveryUnknownAtMs: 120,
      },
    ]) {
      expect(isCoherentRequestMetadata({ ...answered, ...delivery, updatedAtMs: 200 })).toBe(true);
    }
    expect(
      isCoherentRequestMetadata({
        ...answered,
        deliveryState: "delivery_failed",
        submittedAtMs: 110,
        deliveryFailedAtMs: 210,
        updatedAtMs: 210,
      }),
    ).toBe(true);
    expect(
      isCoherentRequestMetadata({
        ...answered,
        deliveryState: "delivery_failed",
        submittedAtMs: 110,
        deliveryFailedAtMs: 199,
        updatedAtMs: 200,
      }),
    ).toBe(false);
    const reached = availableResult(base, digest, "wait", 200);
    expect(
      isCoherentRequestMetadata({
        ...reached,
        deliveryState: "delivery_failed",
        submittedAtMs: 110,
        deliveryFailedAtMs: 1100,
        updatedAtMs: 1100,
      }),
    ).toBe(true);
  });

  test("composite helpers enforce atomic semantics without imposing native admission", async () => {
    const ask = await pendingAsk();
    const submitting: PendingRequestMetadata = {
      ...(await commonMetadata()),
      payloadSha256: await contentDigest(),
      kind: "ask",
      resolutionState: "pending",
      deliveryState: "submitting",
      submittedAtMs: 110,
      resultState: "none",
      updatedAtMs: 110,
    };
    const wait: PendingRequestMetadata = {
      ...(await commonMetadata()),
      payloadSha256: await contentDigest(),
      kind: "wait",
      resolutionState: "pending",
      deliveryState: "delivery_unknown",
      submittedAtMs: 110,
      deliveryUnknownAtMs: 120,
      resultState: "none",
      updatedAtMs: 120,
    };
    expect(canAtomicallyAnswerWithAvailableResult(ask, 999)).toBe(true);
    expect(canAtomicallyAnswerWithAvailableResult(ask, 1000)).toBe(false);
    expect(canAtomicallyReachWithAvailableResult(wait, 999)).toBe(true);
    for (const [failedAtMs, expected] of [
      [109, false],
      [110, true],
      [111, true],
    ] as const) {
      expect(canAtomicallyFailPendingRequestDelivery(submitting, failedAtMs)).toBe(expected);
    }
    for (const [failedAtMs, expected] of [
      [119, false],
      [120, true],
      [121, true],
    ] as const) {
      expect(canAtomicallyFailPendingRequestDelivery(wait, failedAtMs)).toBe(expected);
    }
    expect(canAtomicallyFailPendingRequestDelivery(ask, 999)).toBe(false);
    const available = {
      ...availableResult(await commonMetadata(), await contentDigest(), "ask", 200),
      deliveryState: "prepared",
      updatedAtMs: 200,
    };
    if (!isCoherentRequestMetadata(available)) throw new Error("invalid available fixture");
    expect(canExpireAvailableRequestResult(available, available.resultExpiresAtMs)).toBe(true);
    expect(canExpireAvailableRequestResult(available, available.resultExpiresAtMs - 1)).toBe(false);
    expect(canAcknowledgeRequestResult(available, 200)).toBe(true);
    expect(canAcknowledgeRequestResult(available, 199)).toBe(false);
    const expired = {
      ...(await commonMetadata()),
      kind: "ask",
      resolutionState: "answered",
      resolvedAtMs: 200,
      deliveryState: "prepared",
      resultState: "expired",
      resultAvailableAtMs: 200,
      resultExpiresAtMs: available.resultExpiresAtMs,
      resultExpiredAtMs: available.resultExpiresAtMs,
      updatedAtMs: available.resultExpiresAtMs,
    };
    if (!isCoherentRequestMetadata(expired)) throw new Error("invalid expired fixture");
    expect(canAcknowledgeRequestResult(expired, expired.resultExpiredAtMs)).toBe(true);
    expect(canAcknowledgeRequestResult(expired, expired.resultExpiredAtMs - 1)).toBe(false);
    expect(
      isCoherentRequestMetadata({
        ...expired,
        resultState: "acknowledged",
        acknowledgedAtMs: expired.resultExpiredAtMs - 1,
      }),
    ).toBe(false);
  });

  test("rejects malformed core metadata and stale content fields", async () => {
    const base = await pendingAsk();
    expect(isCoherentRequestMetadata({ ...base, deadlineAtMs: 100 })).toBe(false);
    expect(
      isCoherentRequestMetadata({
        ...base,
        payloadByteLength: requestLimits.canonicalContentBytes + 1,
      }),
    ).toBe(false);
    expect(isCoherentRequestMetadata({ ...base, targetSessionId: base.sourceSessionId })).toBe(
      false,
    );
    expect(isCoherentRequestMetadata({ ...base, resolvedAtMs: 200 })).toBe(false);
    expect(isCoherentRequestMetadata({ ...base, resultSha256: base.payloadSha256 })).toBe(false);
    expect(isCoherentRequestMetadata({ ...base, unexpected: true })).toBe(false);
  });
});
