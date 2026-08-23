import type { RequestId } from "../domain/generated-ids";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { type RequestStoreFailureCode, requestStoreFailureCodes } from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

function failure(code: RequestStoreFailureCode): DomainResult<never> {
  return domainFailure(
    code,
    code === "ownership_lost"
      ? "Coordinator ownership was lost."
      : "Request expiry data is invalid.",
    code === "storage_unavailable" || code === "rate_limited",
  );
}

export function inspectExpiredRequestBatch(input: {
  readonly value: unknown;
  readonly workspaceKey: WorkspaceKey;
  readonly seen: Set<RequestId>;
  readonly batchLimit: number;
  readonly hardLimit: number;
}): DomainResult<readonly (RequestMetadata & { readonly resolutionState: "deadline_expired" })[]> {
  const result = snapshotDataRecord(input.value, 2);
  if (!result) return failure("storage_unavailable");
  const keys = Object.keys(result);
  if (result.ok === false) {
    const code = result.code as RequestStoreFailureCode;
    return keys.length === 2 && requestStoreFailureCodes.includes(code)
      ? failure(code)
      : failure("storage_unavailable");
  }
  const rawRequests = snapshotDenseArray(result.requests, input.batchLimit);
  if (result.ok !== true || keys.length !== 2 || !keys.includes("requests") || !rawRequests) {
    return failure("storage_unavailable");
  }
  const expired: Array<RequestMetadata & { readonly resolutionState: "deadline_expired" }> = [];
  for (const rawRequest of rawRequests) {
    const request = inspectRequestMetadata(rawRequest);
    if (
      !request ||
      !isCoherentRequestMetadata(request) ||
      request.workspaceKey !== input.workspaceKey ||
      request.resolutionState !== "deadline_expired" ||
      input.seen.has(request.id) ||
      input.seen.size >= input.hardLimit
    ) {
      return failure("storage_unavailable");
    }
    input.seen.add(request.id);
    expired.push(request);
  }
  return { ok: true, value: expired };
}
