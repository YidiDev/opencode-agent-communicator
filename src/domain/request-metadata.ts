import {
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "./generated-ids";
import { requestLimits } from "./request-constants";
import { resolutionAppliesToRequestKind } from "./request-transitions";
import {
  type RequestMetadata,
  requestDeliveryModes,
  requestDeliveryStates,
  requestKinds,
  requestResolutionStates,
  requestResultStates,
} from "./request-types";
import { safeInteger } from "./request-validation";
import { validateSessionId } from "./sessions";
import { validateWorkspaceKey } from "./workspaces";

const deliveryFields = [
  "submittedAtMs",
  "deliveryUnknownAtMs",
  "admittedAtMs",
  "promotedAtMs",
  "deliveryFailedAtMs",
  "admissionEvidence",
] as const;
const resolutionFields = ["resolvedAtMs"] as const;
const resultFields = [
  "resultByteLength",
  "resultSha256",
  "resultAvailableAtMs",
  "resultExpiresAtMs",
  "resultExpiredAtMs",
  "acknowledgedAtMs",
] as const;
const payloadIdentityFields = ["payloadSha256"] as const;
const failedDeliveryStates: readonly string[] = ["delivery_failed"];
const requiredFields = [
  "id",
  "workspaceKey",
  "sourceSessionId",
  "targetSessionId",
  "nativeMessageId",
  "kind",
  "resolutionState",
  "deliveryState",
  "resultState",
  "payloadByteLength",
  "createdAtMs",
  "updatedAtMs",
  "deadlineAtMs",
] as const;
const metadataFields = [
  ...requiredFields,
  ...payloadIdentityFields,
  ...deliveryFields,
  ...resolutionFields,
  ...resultFields,
  "deliveryMode",
  "linkedStartOperationId",
];

function isMetadataCandidate(value: unknown): value is RequestMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return requiredFields.every((field) => field in value);
}

function validTopLevelShape(value: RequestMetadata): boolean {
  const keys = Object.keys(value);
  return (
    requiredFields.every((field) => keys.includes(field)) &&
    keys.every((key) => (metadataFields as readonly string[]).includes(key)) &&
    requestKinds.includes(value.kind) &&
    (value.deliveryMode === undefined || requestDeliveryModes.includes(value.deliveryMode)) &&
    requestResolutionStates.includes(value.resolutionState) &&
    requestDeliveryStates.includes(value.deliveryState) &&
    requestResultStates.includes(value.resultState)
  );
}

function validIdentities(value: RequestMetadata): boolean {
  return (
    validateRequestId(value.id).ok &&
    validateWorkspaceKey(value.workspaceKey).ok &&
    validateSessionId(value.sourceSessionId).ok &&
    validateSessionId(value.targetSessionId).ok &&
    value.sourceSessionId !== value.targetSessionId &&
    validateNativeMessageId(value.nativeMessageId).ok &&
    (value.linkedStartOperationId === undefined ||
      validateStartOperationId(value.linkedStartOperationId).ok) &&
    ((value.deliveryMode ?? "steer") === "initial") === (value.linkedStartOperationId !== undefined)
  );
}

function coherentPayloadIdentity(value: RequestMetadata): boolean {
  return value.resolutionState === "pending"
    ? typeof value.payloadSha256 === "string" && /^[0-9a-f]{64}$/.test(value.payloadSha256)
    : !Object.hasOwn(value, "payloadSha256");
}

function validCoreNumbers(value: RequestMetadata): boolean {
  return (
    safeInteger(value.createdAtMs) &&
    safeInteger(value.updatedAtMs) &&
    safeInteger(value.deadlineAtMs) &&
    value.createdAtMs <= value.updatedAtMs &&
    value.deadlineAtMs > value.createdAtMs &&
    safeInteger(value.payloadByteLength) &&
    value.payloadByteLength > 0 &&
    value.payloadByteLength <= requestLimits.canonicalContentBytes
  );
}

function transitionTime(value: RequestMetadata, timestamp: unknown): timestamp is number {
  return safeInteger(timestamp) && timestamp >= value.createdAtMs && timestamp <= value.updatedAtMs;
}

function onlyFields(
  value: RequestMetadata,
  universe: readonly (keyof RequestMetadata)[],
  allowed: readonly (keyof RequestMetadata)[],
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

function coherentRequestDelivery(value: RequestMetadata): boolean {
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

function coherentResolution(value: RequestMetadata): boolean {
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

function coherentResult(value: RequestMetadata): boolean {
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

export function isCoherentRequestMetadata(value: unknown): value is RequestMetadata {
  return (
    isMetadataCandidate(value) &&
    validTopLevelShape(value) &&
    validIdentities(value) &&
    validCoreNumbers(value) &&
    coherentPayloadIdentity(value) &&
    coherentRequestDelivery(value) &&
    coherentResolution(value) &&
    coherentResult(value)
  );
}
