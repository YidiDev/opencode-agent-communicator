import { validateNativeMessageId } from "./generated-ids";
import { requestLimits } from "./request-constants";
import { resolutionAppliesToRequestKind } from "./request-transitions";
import type { RequestMetadata } from "./request-types";
import { safeInteger } from "./request-validation";

const deliveryFields = [
  "awaitingContextAtMs",
  "contextAdmittedAtMs",
  "submittedAtMs",
  "deliveryUnknownAtMs",
  "admittedAtMs",
  "promotedAtMs",
  "deliveryFailedAtMs",
  "admissionEvidence",
] as const;
const resolutionFields = ["resolvedAtMs"] as const;
const failedDeliveryStates: readonly string[] = ["delivery_failed"];
const resultFields = [
  "resultByteLength",
  "resultSha256",
  "resultAvailableAtMs",
  "resultExpiresAtMs",
  "resultExpiredAtMs",
  "acknowledgedAtMs",
] as const;

function transitionTime(value: RequestMetadata, timestamp: unknown): timestamp is number {
  return safeInteger(timestamp) && timestamp >= value.createdAtMs && timestamp <= value.updatedAtMs;
}

function onlyFields(
  value: RequestMetadata,
  universe: readonly string[],
  allowed: readonly string[],
): boolean {
  return universe.every((field) => allowed.includes(field) || !Object.hasOwn(value, field));
}

function validEvidence(value: RequestMetadata, state: "admitted" | "promoted"): boolean {
  const evidence = value.admissionEvidence;
  if (
    !evidence ||
    evidence.state !== state ||
    !safeInteger(evidence.admittedSeq) ||
    !transitionTime(value, evidence.observedAtMs)
  ) {
    return false;
  }
  const evidenceKeys = Object.keys(evidence);
  const expectedKeys =
    state === "admitted"
      ? ["state", "nativeMessageId", "admittedSeq", "observedAtMs"]
      : ["state", "nativeMessageId", "admittedSeq", "promotedSeq", "observedAtMs"];
  if (
    evidenceKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => evidenceKeys.includes(key))
  ) {
    return false;
  }
  if (!validateNativeMessageId(evidence.nativeMessageId).ok) return false;
  if (evidence.nativeMessageId !== value.nativeMessageId) return false;
  if (state === "admitted") {
    return transitionTime(value, value.admittedAtMs) && evidence.observedAtMs >= value.admittedAtMs;
  }
  return (
    evidence.state === "promoted" &&
    safeInteger(evidence.promotedSeq) &&
    evidence.promotedSeq > evidence.admittedSeq &&
    transitionTime(value, value.submittedAtMs) &&
    transitionTime(value, value.admittedAtMs) &&
    transitionTime(value, value.promotedAtMs) &&
    value.admittedAtMs >= value.submittedAtMs &&
    value.promotedAtMs >= value.admittedAtMs &&
    evidence.observedAtMs >= value.promotedAtMs
  );
}

function coherentContextRequestDelivery(value: RequestMetadata): boolean {
  if (value.deliveryState === "prepared") return onlyFields(value, deliveryFields, []);
  if (value.deliveryState === "awaiting_context") {
    return (
      onlyFields(value, deliveryFields, ["awaitingContextAtMs"]) &&
      transitionTime(value, value.awaitingContextAtMs)
    );
  }
  if (value.deliveryState === "context_admitted") {
    return (
      onlyFields(value, deliveryFields, ["awaitingContextAtMs", "contextAdmittedAtMs"]) &&
      transitionTime(value, value.awaitingContextAtMs) &&
      transitionTime(value, value.contextAdmittedAtMs) &&
      value.contextAdmittedAtMs >= value.awaitingContextAtMs
    );
  }
  if (value.deliveryState !== "delivery_failed") return false;
  const failed = value as RequestMetadata & {
    readonly awaitingContextAtMs: number;
    readonly deliveryFailedAtMs: number;
  };
  return (
    onlyFields(value, deliveryFields, ["awaitingContextAtMs", "deliveryFailedAtMs"]) &&
    transitionTime(value, failed.awaitingContextAtMs) &&
    transitionTime(value, failed.deliveryFailedAtMs) &&
    failed.deliveryFailedAtMs >= failed.awaitingContextAtMs
  );
}

function coherentNativeRequestDelivery(value: RequestMetadata): boolean {
  if (value.deliveryState === "awaiting_context" || value.deliveryState === "context_admitted") {
    return false;
  }
  if (value.deliveryState === "prepared") return onlyFields(value, deliveryFields, []);
  if (!transitionTime(value, value.submittedAtMs)) return false;
  if (value.deliveryState === "submitting") {
    return onlyFields(value, deliveryFields, ["submittedAtMs"]);
  }
  if (value.deliveryState === "delivery_unknown") {
    return (
      onlyFields(value, deliveryFields, ["submittedAtMs", "deliveryUnknownAtMs"]) &&
      transitionTime(value, value.deliveryUnknownAtMs) &&
      value.deliveryUnknownAtMs >= value.submittedAtMs
    );
  }
  if (value.deliveryState === "delivery_failed") {
    const allowed = Object.hasOwn(value, "deliveryUnknownAtMs")
      ? (["submittedAtMs", "deliveryUnknownAtMs", "deliveryFailedAtMs"] as const)
      : (["submittedAtMs", "deliveryFailedAtMs"] as const);
    if (
      !onlyFields(value, deliveryFields, allowed) ||
      !transitionTime(value, value.deliveryFailedAtMs)
    ) {
      return false;
    }
    if (!Object.hasOwn(value, "deliveryUnknownAtMs")) {
      return value.deliveryFailedAtMs >= value.submittedAtMs;
    }
    return (
      transitionTime(value, value.deliveryUnknownAtMs) &&
      value.deliveryUnknownAtMs >= value.submittedAtMs &&
      value.deliveryFailedAtMs >= value.deliveryUnknownAtMs
    );
  }
  const allowed =
    value.deliveryState === "admitted"
      ? (["submittedAtMs", "admittedAtMs", "admissionEvidence"] as const)
      : (["submittedAtMs", "admittedAtMs", "promotedAtMs", "admissionEvidence"] as const);
  return (
    onlyFields(value, deliveryFields, allowed) &&
    transitionTime(value, value.admittedAtMs) &&
    value.admittedAtMs >= value.submittedAtMs &&
    validEvidence(value, value.deliveryState)
  );
}

export function coherentRequestDelivery(value: RequestMetadata): boolean {
  return (value.deliveryMode ?? "steer") === "context"
    ? coherentContextRequestDelivery(value)
    : coherentNativeRequestDelivery(value);
}

export function coherentRequestResolution(value: RequestMetadata): boolean {
  if (!resolutionAppliesToRequestKind(value.kind, value.resolutionState)) return false;
  if (value.resolutionState === "pending") {
    return (
      onlyFields(value, resolutionFields, []) && !failedDeliveryStates.includes(value.deliveryState)
    );
  }
  if (!transitionTime(value, value.resolvedAtMs)) return false;
  const deadlineCoherent =
    value.resolutionState === "deadline_expired"
      ? value.resolvedAtMs >= value.deadlineAtMs
      : value.resolvedAtMs < value.deadlineAtMs;
  if (!deadlineCoherent) return false;
  const failedResolution = value.resolutionState === "delivery_failed";
  const failedDelivery = value.deliveryState === "delivery_failed";
  if (failedResolution) {
    return failedDelivery && value.resolvedAtMs === value.deliveryFailedAtMs;
  }
  if (!failedDelivery) return true;
  return value.deliveryFailedAtMs >= value.resolvedAtMs;
}

function validResultIdentity(value: RequestMetadata): boolean {
  return (
    safeInteger(value.resultByteLength) &&
    value.resultByteLength > 0 &&
    value.resultByteLength <= requestLimits.canonicalContentBytes &&
    typeof value.resultSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.resultSha256)
  );
}

export function coherentRequestResult(value: RequestMetadata): boolean {
  const successful = value.resolutionState === "answered" || value.resolutionState === "reached";
  if (value.resultState === "none") return !successful && onlyFields(value, resultFields, []);
  if (!successful) return false;
  if (
    !transitionTime(value, value.resultAvailableAtMs) ||
    value.resultAvailableAtMs !== value.resolvedAtMs ||
    !safeInteger(value.resultExpiresAtMs) ||
    value.resultExpiresAtMs !== value.resultAvailableAtMs + requestLimits.resultRetentionMs
  ) {
    return false;
  }
  if (value.resultState === "available") {
    return (
      validResultIdentity(value) &&
      onlyFields(value, resultFields, [
        "resultByteLength",
        "resultSha256",
        "resultAvailableAtMs",
        "resultExpiresAtMs",
      ])
    );
  }
  if (value.resultState === "expired") {
    return (
      onlyFields(value, resultFields, [
        "resultAvailableAtMs",
        "resultExpiresAtMs",
        "resultExpiredAtMs",
      ]) &&
      transitionTime(value, value.resultExpiredAtMs) &&
      value.resultExpiredAtMs >= value.resultExpiresAtMs
    );
  }
  if (
    !onlyFields(value, resultFields, [
      "resultAvailableAtMs",
      "resultExpiresAtMs",
      "resultExpiredAtMs",
      "acknowledgedAtMs",
    ])
  ) {
    return false;
  }
  if (!transitionTime(value, value.acknowledgedAtMs)) return false;
  if (value.acknowledgedAtMs < value.resultAvailableAtMs) return false;
  if (!Object.hasOwn(value, "resultExpiredAtMs")) return true;
  return (
    transitionTime(value, value.resultExpiredAtMs) &&
    value.resultExpiredAtMs >= value.resultExpiresAtMs &&
    value.acknowledgedAtMs >= value.resultExpiredAtMs
  );
}
