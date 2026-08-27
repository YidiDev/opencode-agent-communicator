import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import type { WorkspaceKey } from "../domain/workspaces";
import type { RequestDeadlinePumpFaultCode } from "./request-deadline-maintenance";
import type { RequestStoreFailureCode } from "./request-ports";
import { requestStoreFailureCodes } from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export const requestDeadlineBatchLimit = 100;
export const requestDeadlineMaximumExpiredRowsPerPump = 2_048;

export interface RequestDeadlineInspectionBudget {
  readonly seen: Set<string>;
  expiredRows: number;
}

export type RequestDeadlineExpirationInspection =
  | Readonly<{ readonly ok: true; readonly requests: readonly RequestMetadata[] }>
  | Readonly<{ readonly ok: false; readonly code: RequestDeadlinePumpFaultCode }>;

function classifyStoreFailure(code: RequestStoreFailureCode): RequestDeadlinePumpFaultCode {
  return code === "ownership_lost" ? "ownership_lost" : "storage_failure";
}

export function inspectRequestDeadlineExpiration(
  value: unknown,
  budget: RequestDeadlineInspectionBudget,
  workspaceKey: WorkspaceKey,
): RequestDeadlineExpirationInspection {
  try {
    const result = snapshotDataRecord(value, 2);
    if (!result) throw new TypeError();
    const keys = Object.keys(result);
    if (result.ok === false) {
      if (
        keys.length !== 2 ||
        !keys.includes("code") ||
        !requestStoreFailureCodes.includes(result.code as RequestStoreFailureCode)
      ) {
        throw new TypeError();
      }
      return { ok: false, code: classifyStoreFailure(result.code as RequestStoreFailureCode) };
    }
    if (result.ok !== true || keys.length !== 2 || !keys.includes("requests")) {
      throw new TypeError();
    }
    const rawRequests = snapshotDenseArray(result.requests, requestDeadlineBatchLimit);
    if (!rawRequests) throw new TypeError();
    if (budget.expiredRows + rawRequests.length > requestDeadlineMaximumExpiredRowsPerPump) {
      throw new TypeError();
    }
    const requests: RequestMetadata[] = [];
    for (const raw of rawRequests) {
      const request = inspectRequestMetadata(raw);
      if (
        !request ||
        !isCoherentRequestMetadata(request) ||
        request.workspaceKey !== workspaceKey ||
        request.resolutionState !== "deadline_expired" ||
        budget.seen.has(request.id as string)
      ) {
        throw new TypeError();
      }
      budget.seen.add(request.id as string);
      requests.push(Object.freeze(request) as unknown as RequestMetadata);
    }
    budget.expiredRows += requests.length;
    return { ok: true, requests };
  } catch {
    return { ok: false, code: "port_contract_violation" };
  }
}
