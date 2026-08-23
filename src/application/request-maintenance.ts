import type { RequestId } from "../domain/generated-ids";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import { availableResultsPerWorkspaceHardCeiling } from "../domain/safety-ceilings";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import type {
  RequestResultRetentionPersistencePort,
  RequestRetentionPersistencePort,
  RequestStoreFailureCode,
} from "./request-ports";
import { requestStoreFailureCodes } from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export const requestMaintenanceBatchLimit = 100;
export const requestRecurringMaintenanceHardBudget = 1_024;
export const requestStartupResultExpiryHardBudget = availableResultsPerWorkspaceHardCeiling;
export const requestRecurringResultExpiryHardBudget = availableResultsPerWorkspaceHardCeiling;

export interface RequestMaintenancePorts {
  readonly resultRetention: RequestResultRetentionPersistencePort;
  readonly requestRetention: RequestRetentionPersistencePort;
}

export type RequestMaintenanceResult =
  | Readonly<{
      readonly ok: true;
      readonly expiredResults: number;
      readonly deletedRequests: number;
      readonly deletedRateEvents: number;
    }>
  | Readonly<{ readonly ok: false; readonly code: RequestStoreFailureCode | "contract" }>;

function failureCode(value: unknown): RequestStoreFailureCode | undefined {
  return typeof value === "string" &&
    requestStoreFailureCodes.includes(value as RequestStoreFailureCode)
    ? (value as RequestStoreFailureCode)
    : undefined;
}

function inspectExpiredResult(
  raw: unknown,
  workspaceKey: WorkspaceKey,
  limit: number,
  seen: Set<RequestId>,
): RequestMaintenanceResult | number {
  const result = snapshotDataRecord(raw, 2);
  if (!result) return { ok: false, code: "contract" };
  if (result.ok === false) {
    const code = failureCode(result.code);
    return code && Object.keys(result).length === 2
      ? { ok: false, code }
      : { ok: false, code: "contract" };
  }
  const batch = result.ok === true ? snapshotDenseArray(result.requests, limit) : undefined;
  if (!batch || Object.keys(result).length !== 2) return { ok: false, code: "contract" };
  for (const rawRequest of batch) {
    const request = inspectRequestMetadata(rawRequest);
    if (
      !request ||
      !isCoherentRequestMetadata(request) ||
      request.workspaceKey !== workspaceKey ||
      (request.resolutionState !== "answered" && request.resolutionState !== "reached") ||
      request.resultState !== "expired" ||
      seen.has(request.id)
    ) {
      return { ok: false, code: "contract" };
    }
    seen.add(request.id);
  }
  return batch.length;
}

async function expireResults(
  ports: RequestMaintenancePorts,
  fencingToken: FencingToken,
  workspaceKey: WorkspaceKey,
  shouldStop: () => boolean,
  abort: AbortSignal,
  hardBudget: number,
): Promise<RequestMaintenanceResult> {
  let expiredResults = 0;
  const seen = new Set<RequestId>();
  while (true) {
    if (shouldStop()) return { ok: false, code: "ownership_lost" };
    if (expiredResults === hardBudget) {
      return { ok: true, expiredResults, deletedRequests: 0, deletedRateEvents: 0 };
    }
    const limit = Math.min(requestMaintenanceBatchLimit, hardBudget - expiredResults);
    let raw: unknown;
    try {
      const settlement = await runUntilAborted(abort, () =>
        ports.resultRetention.expireAvailableResults({ fencingToken, workspaceKey, limit }),
      );
      if (settlement.kind === "aborted") return { ok: false, code: "ownership_lost" };
      if (settlement.kind === "rejected") throw settlement.cause;
      raw = settlement.value;
    } catch (cause: unknown) {
      return {
        ok: false,
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      };
    }
    const inspected = inspectExpiredResult(raw, workspaceKey, limit, seen);
    if (typeof inspected !== "number") return inspected;
    expiredResults += inspected;
    if (inspected < limit) {
      return { ok: true, expiredResults, deletedRequests: 0, deletedRateEvents: 0 };
    }
  }
  return { ok: true, expiredResults, deletedRequests: 0, deletedRateEvents: 0 };
}

function inspectRetentionResult(
  raw: unknown,
  limit: number,
):
  | Readonly<{ readonly requests: number; readonly rates: number }>
  | Readonly<{ readonly failure: RequestMaintenanceResult }> {
  const result = snapshotDataRecord(raw, 3);
  if (!result) return { failure: { ok: false, code: "contract" } };
  if (result.ok === false) {
    const code = failureCode(result.code);
    return {
      failure:
        code && Object.keys(result).length === 2
          ? { ok: false, code }
          : { ok: false, code: "contract" },
    };
  }
  if (
    result.ok !== true ||
    Object.keys(result).length !== 3 ||
    !Number.isSafeInteger(result.deletedRequests) ||
    (result.deletedRequests as number) < 0 ||
    (result.deletedRequests as number) > limit ||
    !Number.isSafeInteger(result.deletedRateEvents) ||
    (result.deletedRateEvents as number) < 0 ||
    (result.deletedRateEvents as number) > limit
  ) {
    return { failure: { ok: false, code: "contract" } };
  }
  return { requests: result.deletedRequests as number, rates: result.deletedRateEvents as number };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: result expiry and independently bounded recurring cleanup share one fenced maintenance outcome.
export async function drainRequestMaintenance(input: {
  readonly ports: RequestMaintenancePorts;
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly shouldStop?: () => boolean;
  readonly abort?: AbortSignal;
  readonly resultExpiryHardBudget?: number;
}): Promise<RequestMaintenanceResult> {
  const shouldStop = input.shouldStop ?? (() => false);
  const abort = input.abort ?? new AbortController().signal;
  const expired = await expireResults(
    input.ports,
    input.fencingToken,
    input.workspaceKey,
    shouldStop,
    abort,
    input.resultExpiryHardBudget ?? requestRecurringResultExpiryHardBudget,
  );
  if (!expired.ok) return expired;
  let deletedRequests = 0;
  let deletedRateEvents = 0;
  while (
    deletedRequests < requestRecurringMaintenanceHardBudget ||
    deletedRateEvents < requestRecurringMaintenanceHardBudget
  ) {
    if (shouldStop()) return { ok: false, code: "ownership_lost" };
    const remaining = Math.min(
      requestRecurringMaintenanceHardBudget - deletedRequests,
      requestRecurringMaintenanceHardBudget - deletedRateEvents,
    );
    if (remaining < 1) break;
    const limit = Math.min(requestMaintenanceBatchLimit, remaining);
    let raw: unknown;
    try {
      const settlement = await runUntilAborted(abort, () =>
        input.ports.requestRetention.collectRequestRetention({
          fencingToken: input.fencingToken,
          workspaceKey: input.workspaceKey,
          limit,
        }),
      );
      if (settlement.kind === "aborted") return { ok: false, code: "ownership_lost" };
      if (settlement.kind === "rejected") throw settlement.cause;
      raw = settlement.value;
    } catch (cause: unknown) {
      return {
        ok: false,
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      };
    }
    const inspected = inspectRetentionResult(raw, limit);
    if ("failure" in inspected) return inspected.failure;
    const { requests, rates } = inspected;
    deletedRequests += requests;
    deletedRateEvents += rates;
    if (requests < limit && rates < limit) break;
  }
  return {
    ok: true,
    expiredResults: expired.expiredResults,
    deletedRequests,
    deletedRateEvents,
  };
}
