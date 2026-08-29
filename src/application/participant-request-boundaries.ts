import { validateRequestId, validateStartOperationId } from "../domain/generated-ids";
import { validateSessionId } from "../domain/sessions";
import type { ParticipantRequestMetadata } from "./request-ports";
import { snapshotDataRecord } from "./strict-port-boundaries";

const allowedKeys = [
  "requestId",
  "participantRole",
  "kind",
  "sourceSessionId",
  "targetSessionId",
  "resolutionState",
  "deliveryState",
  "deliveryMode",
  "linkedStartOperationId",
  "resultState",
  "createdAtMs",
  "updatedAtMs",
  "deadlineAtMs",
  "resolvedAtMs",
  "submittedAtMs",
  "deliveryUnknownAtMs",
  "admittedAtMs",
  "promotedAtMs",
  "deliveryFailedAtMs",
  "resultAvailableAtMs",
  "resultExpiresAtMs",
  "resultExpiredAtMs",
  "acknowledgedAtMs",
] as const;

const requiredKeys = [
  "requestId",
  "participantRole",
  "kind",
  "sourceSessionId",
  "targetSessionId",
  "resolutionState",
  "deliveryState",
  "resultState",
  "createdAtMs",
  "updatedAtMs",
  "deadlineAtMs",
] as const;
const optionalTimeKeys = [
  "resolvedAtMs",
  "submittedAtMs",
  "deliveryUnknownAtMs",
  "admittedAtMs",
  "promotedAtMs",
  "deliveryFailedAtMs",
  "resultAvailableAtMs",
  "resultExpiresAtMs",
  "resultExpiredAtMs",
  "acknowledgedAtMs",
] as const;
const resolutions = [
  "pending",
  "answered",
  "reached",
  "deadline_expired",
  "cancelled",
  "delivery_failed",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
];
const deliveries = [
  "prepared",
  "submitting",
  "delivery_unknown",
  "admitted",
  "promoted",
  "delivery_failed",
];
const results = ["none", "available", "expired", "acknowledged"];

function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Strictly snapshots and correlates the complete allowlisted participant metadata projection. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one strict allowlisted metadata correlation boundary is safer than state-dependent partial validators.
export function inspectParticipantRequestMetadata(
  value: unknown,
): ParticipantRequestMetadata | undefined {
  const data = snapshotDataRecord(value, allowedKeys.length);
  if (!data) return undefined;
  const keys = Object.keys(data);
  if (
    !requiredKeys.every((key) => keys.includes(key)) ||
    keys.some((key) => !allowedKeys.includes(key as (typeof allowedKeys)[number])) ||
    !validateRequestId(data.requestId).ok ||
    (data.participantRole !== "source" && data.participantRole !== "target") ||
    (data.kind !== "ask" && data.kind !== "wait") ||
    !validateSessionId(data.sourceSessionId).ok ||
    !validateSessionId(data.targetSessionId).ok ||
    data.sourceSessionId === data.targetSessionId ||
    !resolutions.includes(data.resolutionState as string) ||
    !deliveries.includes(data.deliveryState as string) ||
    (data.deliveryMode !== undefined &&
      data.deliveryMode !== "steer" &&
      data.deliveryMode !== "queue" &&
      data.deliveryMode !== "initial") ||
    (data.linkedStartOperationId !== undefined &&
      !validateStartOperationId(data.linkedStartOperationId).ok) ||
    ((data.deliveryMode ?? "steer") === "initial") !==
      Object.hasOwn(data, "linkedStartOperationId") ||
    !results.includes(data.resultState as string) ||
    !safeTime(data.createdAtMs) ||
    !safeTime(data.updatedAtMs) ||
    !safeTime(data.deadlineAtMs) ||
    data.updatedAtMs < data.createdAtMs ||
    data.deadlineAtMs <= data.createdAtMs
  )
    return undefined;
  for (const key of optionalTimeKeys) {
    if (Object.hasOwn(data, key) && !safeTime(data[key])) return undefined;
  }

  const pending = data.resolutionState === "pending";
  if (pending !== !Object.hasOwn(data, "resolvedAtMs")) return undefined;
  if (pending && data.resultState !== "none") return undefined;
  if (
    (data.resolutionState === "answered") !==
    (data.kind === "ask" && data.resultState !== "none")
  )
    return undefined;
  if (
    (data.resolutionState === "reached") !==
    (data.kind === "wait" && data.resultState !== "none")
  )
    return undefined;

  const submitted = data.deliveryState !== "prepared";
  if (submitted !== Object.hasOwn(data, "submittedAtMs")) return undefined;
  if ((data.deliveryState === "delivery_unknown") !== Object.hasOwn(data, "deliveryUnknownAtMs"))
    return undefined;
  if (
    ["admitted", "promoted"].includes(data.deliveryState as string) !==
    Object.hasOwn(data, "admittedAtMs")
  )
    return undefined;
  if ((data.deliveryState === "promoted") !== Object.hasOwn(data, "promotedAtMs")) return undefined;
  if ((data.deliveryState === "delivery_failed") !== Object.hasOwn(data, "deliveryFailedAtMs"))
    return undefined;

  const hasRetainedResultLifecycle = data.resultState !== "none";
  if (
    hasRetainedResultLifecycle !==
    (Object.hasOwn(data, "resultAvailableAtMs") && Object.hasOwn(data, "resultExpiresAtMs"))
  )
    return undefined;
  const hasExpiredAt = Object.hasOwn(data, "resultExpiredAtMs");
  if (data.resultState === "expired" && !hasExpiredAt) return undefined;
  if (data.resultState !== "expired" && data.resultState !== "acknowledged" && hasExpiredAt)
    return undefined;
  if ((data.resultState === "acknowledged") !== Object.hasOwn(data, "acknowledgedAtMs"))
    return undefined;
  if (
    hasRetainedResultLifecycle &&
    ((data.resultAvailableAtMs as number) !== data.resolvedAtMs ||
      (data.resultExpiresAtMs as number) < (data.resultAvailableAtMs as number))
  )
    return undefined;
  if (hasExpiredAt && (data.resultExpiredAtMs as number) < (data.resultExpiresAtMs as number))
    return undefined;
  if (
    data.resultState === "acknowledged" &&
    ((data.acknowledgedAtMs as number) < (data.resultAvailableAtMs as number) ||
      (hasExpiredAt && (data.acknowledgedAtMs as number) < (data.resultExpiredAtMs as number)))
  )
    return undefined;
  return Object.freeze(data) as unknown as ParticipantRequestMetadata;
}
