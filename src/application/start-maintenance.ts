import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import {
  startOperationsPerWorkspaceHardCeiling,
  startRateEventsPerWorkspaceHardCeiling,
} from "../domain/safety-ceilings";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import type {
  StartLimits,
  StartOperationPersistencePort,
  StartStoreFailureCode,
} from "./session-start-ports";

export const startMaintenanceBatchLimit = 100;
const startStoreFailureCodes = new Set<StartStoreFailureCode>([
  "idempotency_conflict",
  "quota_exceeded",
  "rate_limited",
  "state_conflict",
  "ownership_lost",
  "storage_unavailable",
]);

export type StartMaintenanceResult =
  | Readonly<{
      readonly ok: true;
      readonly deletedOperations: number;
      readonly deletedRateEvents: number;
    }>
  | Readonly<{ readonly ok: false; readonly code: StartStoreFailureCode | "contract" }>;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict adapter-result validation and two independent hard budgets form one fenced maintenance boundary.
export async function drainStartMaintenance(input: {
  readonly starts: StartOperationPersistencePort;
  readonly limits: StartLimits;
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly nowMs: number;
  readonly shouldStop?: () => boolean;
  readonly abort?: AbortSignal;
}): Promise<StartMaintenanceResult> {
  const shouldStop = input.shouldStop ?? (() => false);
  const abort = input.abort ?? new AbortController().signal;
  let deletedOperations = 0;
  let deletedRateEvents = 0;
  while (
    deletedOperations < startOperationsPerWorkspaceHardCeiling ||
    deletedRateEvents < startRateEventsPerWorkspaceHardCeiling
  ) {
    if (shouldStop()) return { ok: false, code: "ownership_lost" };
    const remainingOperations = startOperationsPerWorkspaceHardCeiling - deletedOperations;
    const remainingRates = startRateEventsPerWorkspaceHardCeiling - deletedRateEvents;
    const remaining = Math.max(remainingOperations, remainingRates, 0);
    if (remaining < 1) break;
    const limit = Math.min(startMaintenanceBatchLimit, remaining);
    let raw: unknown;
    try {
      const settlement = await runUntilAborted(abort, () =>
        input.starts.collectRetention({
          fencingToken: input.fencingToken,
          workspaceKey: input.workspaceKey,
          nowMs: input.nowMs,
          terminalRetentionMs: input.limits.terminalRetentionMs,
          rateRetentionMs: input.limits.rateWindowMs,
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
    if (typeof raw !== "object" || raw === null || !("ok" in raw)) {
      return { ok: false, code: "contract" };
    }
    if (raw.ok === false) {
      const code = "code" in raw ? raw.code : undefined;
      return typeof code === "string" &&
        startStoreFailureCodes.has(code as StartStoreFailureCode) &&
        Object.keys(raw).length === 2
        ? { ok: false, code: code as StartStoreFailureCode }
        : { ok: false, code: "contract" };
    }
    if (
      raw.ok !== true ||
      Object.keys(raw).length !== 3 ||
      !("deletedOperations" in raw) ||
      !("deletedRateEvents" in raw) ||
      !Number.isSafeInteger(raw.deletedOperations) ||
      !Number.isSafeInteger(raw.deletedRateEvents) ||
      (raw.deletedOperations as number) < 0 ||
      (raw.deletedRateEvents as number) < 0 ||
      (raw.deletedOperations as number) > limit ||
      (raw.deletedRateEvents as number) > limit ||
      (raw.deletedOperations as number) > remainingOperations ||
      (raw.deletedRateEvents as number) > remainingRates
    ) {
      return { ok: false, code: "contract" };
    }
    const operations = raw.deletedOperations as number;
    const rates = raw.deletedRateEvents as number;
    deletedOperations += operations;
    deletedRateEvents += rates;
    if (operations < limit && rates < limit) break;
  }
  return { ok: true, deletedOperations, deletedRateEvents };
}
