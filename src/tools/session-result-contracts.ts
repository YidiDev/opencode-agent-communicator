import { isProxy } from "node:util/types";
import { snapshotDataRecord } from "../application/strict-port-boundaries";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import type { DomainFailureCode } from "../domain/results";
import { isCoherentStartOperation, type StartOperation } from "../domain/session-start";

const startRequiredKeys = [
  "id",
  "workspaceKey",
  "sourceSessionId",
  "idempotencyKey",
  "argumentsSha256",
  "sessionId",
  "nativeMessageId",
  "creationState",
  "titleState",
  "admissionState",
  "createdAtMs",
  "updatedAtMs",
] as const;
const startOptionalKeys = ["requestedAgent", "requestedModel", "titleRequested"] as const;

const requestRequiredKeys = [
  "id",
  "workspaceKey",
  "sourceSessionId",
  "targetSessionId",
  "nativeMessageId",
  "payloadByteLength",
  "createdAtMs",
  "updatedAtMs",
  "deadlineAtMs",
  "kind",
  "resolutionState",
  "deliveryState",
  "resultState",
] as const;
const requestOptionalKeys = [
  "deliveryMode",
  "linkedStartOperationId",
  "payloadSha256",
  "resolvedAtMs",
  "awaitingContextAtMs",
  "contextAdmittedAtMs",
  "submittedAtMs",
  "deliveryUnknownAtMs",
  "admittedAtMs",
  "promotedAtMs",
  "deliveryFailedAtMs",
  "admissionEvidence",
  "resultByteLength",
  "resultSha256",
  "resultAvailableAtMs",
  "resultExpiresAtMs",
  "resultExpiredAtMs",
  "acknowledgedAtMs",
] as const;

export function exactRecordWithOptionalKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && isProxy(value)) return undefined;
  const record = snapshotDataRecord(value, required.length + optional.length);
  if (!record) return undefined;
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key))
    ? record
    : undefined;
}

export interface ExactToolFailure {
  readonly code: DomainFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

export function exactToolSuccess(result: unknown): { readonly value: unknown } | undefined {
  const envelope = exactRecordWithOptionalKeys(result, ["ok", "value"], []);
  return envelope?.ok === true ? { value: envelope.value } : undefined;
}

export function exactToolFailure(
  result: unknown,
  allowedCodes: readonly DomainFailureCode[],
): ExactToolFailure | undefined {
  const envelope = exactRecordWithOptionalKeys(result, ["ok", "error"], []);
  if (envelope?.ok !== false) return undefined;
  const error = exactRecordWithOptionalKeys(
    envelope.error,
    ["code", "message", "retryable"],
    ["details"],
  );
  if (
    !error ||
    (Object.hasOwn(error, "details") && error.details === undefined) ||
    !allowedCodes.includes(error.code as DomainFailureCode) ||
    typeof error.message !== "string" ||
    typeof error.retryable !== "boolean"
  ) {
    return undefined;
  }
  return error.details === undefined
    ? {
        code: error.code as DomainFailureCode,
        message: error.message,
        retryable: error.retryable,
      }
    : {
        code: error.code as DomainFailureCode,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      };
}

export function exactStartOperation(value: unknown): StartOperation | undefined {
  const operation = exactRecordWithOptionalKeys(value, startRequiredKeys, startOptionalKeys);
  return operation && isCoherentStartOperation(operation)
    ? (operation as unknown as StartOperation)
    : undefined;
}

export function exactRequestMetadata(value: unknown): RequestMetadata | undefined {
  const request = exactRecordWithOptionalKeys(value, requestRequiredKeys, requestOptionalKeys);
  return request && isCoherentRequestMetadata(request)
    ? (request as unknown as RequestMetadata)
    : undefined;
}
