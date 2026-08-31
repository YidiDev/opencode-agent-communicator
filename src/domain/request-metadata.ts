import {
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "./generated-ids";
import { requestLimits } from "./request-constants";
import {
  coherentRequestDelivery,
  coherentRequestResolution,
  coherentRequestResult,
} from "./request-metadata-state";
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

const payloadIdentityFields = ["payloadSha256"] as const;
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
  "submittedAtMs",
  "awaitingContextAtMs",
  "contextAdmittedAtMs",
  "deliveryUnknownAtMs",
  "admittedAtMs",
  "promotedAtMs",
  "deliveryFailedAtMs",
  "admissionEvidence",
  "resolvedAtMs",
  "resultByteLength",
  "resultSha256",
  "resultAvailableAtMs",
  "resultExpiresAtMs",
  "resultExpiredAtMs",
  "acknowledgedAtMs",
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
    ((value.deliveryMode ?? "steer") === "initial") ===
      (value.linkedStartOperationId !== undefined) &&
    ((value.deliveryMode ?? "steer") !== "context" || value.linkedStartOperationId === undefined)
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

export function isCoherentRequestMetadata(value: unknown): value is RequestMetadata {
  return (
    isMetadataCandidate(value) &&
    validTopLevelShape(value) &&
    validIdentities(value) &&
    validCoreNumbers(value) &&
    coherentPayloadIdentity(value) &&
    coherentRequestDelivery(value) &&
    coherentRequestResolution(value) &&
    coherentRequestResult(value)
  );
}
