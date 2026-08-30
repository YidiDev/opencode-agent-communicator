import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import type { RequestParticipantActivityObservation } from "./request-ports";
import { snapshotDataRecord } from "./strict-port-boundaries";

const requestMetadataKeys = [
  "id",
  "workspaceKey",
  "sourceSessionId",
  "targetSessionId",
  "nativeMessageId",
  "deliveryMode",
  "linkedStartOperationId",
  "kind",
  "resolutionState",
  "deliveryState",
  "resultState",
  "payloadByteLength",
  "createdAtMs",
  "updatedAtMs",
  "deadlineAtMs",
  "payloadSha256",
  "submittedAtMs",
  "deliveryUnknownAtMs",
  "admittedAtMs",
  "promotedAtMs",
  "deliveryFailedAtMs",
  "resolvedAtMs",
  "resultByteLength",
  "resultSha256",
  "resultAvailableAtMs",
  "resultExpiresAtMs",
  "resultExpiredAtMs",
  "acknowledgedAtMs",
  "admissionEvidence",
] as const;
const requiredRequestMetadataKeys = [
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

export function inspectRequestMetadata(value: unknown): RequestMetadata | undefined {
  const request = snapshotDataRecord(value, requestMetadataKeys.length);
  if (!request) return undefined;
  const keys = Object.keys(request);
  if (
    !requiredRequestMetadataKeys.every((key) => keys.includes(key)) ||
    keys.some((key) => !requestMetadataKeys.includes(key as never) || request[key] === undefined)
  )
    return undefined;
  if (request.admissionEvidence !== undefined) {
    const evidence = snapshotDataRecord(request.admissionEvidence, 5);
    const expected =
      evidence?.state === "promoted"
        ? ["state", "nativeMessageId", "admittedSeq", "promotedSeq", "observedAtMs"]
        : ["state", "nativeMessageId", "admittedSeq", "observedAtMs"];
    if (
      !evidence ||
      Object.keys(evidence).length !== expected.length ||
      Object.keys(evidence).some((key) => !expected.includes(key))
    )
      return undefined;
    request.admissionEvidence = evidence;
  }
  return isCoherentRequestMetadata(request)
    ? (Object.freeze(request) as unknown as RequestMetadata)
    : undefined;
}

export function inspectParticipantObservation(
  value: unknown,
): RequestParticipantActivityObservation | undefined {
  const observation = snapshotDataRecord(value, 3);
  if (!observation || Object.keys(observation).length !== 3) return undefined;
  if (
    typeof observation.sourceVisible !== "boolean" ||
    typeof observation.targetVisible !== "boolean" ||
    !["busy", "retry", "idle", "unknown"].includes(observation.targetStatus as string)
  ) {
    return undefined;
  }
  return Object.freeze({
    sourceVisible: observation.sourceVisible,
    targetVisible: observation.targetVisible,
    targetStatus: observation.targetStatus as RequestParticipantActivityObservation["targetStatus"],
  });
}
