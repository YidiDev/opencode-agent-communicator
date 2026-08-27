import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { snapshotDataRecord } from "./strict-port-boundaries";

export const deliveryRetentionBatchLimit = 100;
export const deliveryRetentionCycleHardBudget = 1_024;

export interface DeliveryRetentionPersistencePort {
  garbageCollectMetadata(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<unknown>;
}

export type DeliveryRetentionResult =
  | Readonly<{
      readonly ok: true;
      readonly deletedDeliveries: number;
      readonly deletedRateEvents: number;
    }>
  | Readonly<{
      readonly ok: false;
      readonly code: "ownership_lost" | "storage_unavailable" | "contract";
    }>;

function inspectBatch(
  raw: unknown,
  limit: number,
): Readonly<{ readonly deliveries: number; readonly rateEvents: number }> | undefined {
  const result = snapshotDataRecord(raw, 3);
  if (
    !result ||
    Object.keys(result).length !== 3 ||
    result.ok !== true ||
    !Number.isSafeInteger(result.deletedDeliveries) ||
    (result.deletedDeliveries as number) < 0 ||
    (result.deletedDeliveries as number) > limit ||
    !Number.isSafeInteger(result.deletedRateEvents) ||
    (result.deletedRateEvents as number) < 0 ||
    (result.deletedRateEvents as number) > limit
  ) {
    return undefined;
  }
  return {
    deliveries: result.deletedDeliveries as number,
    rateEvents: result.deletedRateEvents as number,
  };
}

/** Drains one independently bounded, fenced delivery-retention cycle. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded draining and strict hostile-port classification share one fail-closed cycle boundary.
export async function drainDeliveryRetention(input: {
  readonly persistence: DeliveryRetentionPersistencePort;
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly shouldStop?: () => boolean;
  readonly abort?: AbortSignal;
  readonly hardBudget?: number;
}): Promise<DeliveryRetentionResult> {
  const shouldStop = input.shouldStop ?? (() => false);
  const abort = input.abort ?? new AbortController().signal;
  const hardBudget = input.hardBudget ?? deliveryRetentionCycleHardBudget;
  if (
    !Number.isSafeInteger(hardBudget) ||
    hardBudget < 1 ||
    hardBudget > deliveryRetentionCycleHardBudget
  ) {
    return { ok: false, code: "contract" };
  }
  let deletedDeliveries = 0;
  let deletedRateEvents = 0;
  while (deletedDeliveries < hardBudget && deletedRateEvents < hardBudget) {
    if (shouldStop() || abort.aborted) return { ok: false, code: "ownership_lost" };
    const limit = Math.min(
      deliveryRetentionBatchLimit,
      hardBudget - deletedDeliveries,
      hardBudget - deletedRateEvents,
    );
    let raw: unknown;
    try {
      const settlement = await runUntilAborted(abort, () =>
        input.persistence.garbageCollectMetadata({
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
    const batch = inspectBatch(raw, limit);
    if (!batch) return { ok: false, code: "contract" };
    deletedDeliveries += batch.deliveries;
    deletedRateEvents += batch.rateEvents;
    if (batch.deliveries < limit && batch.rateEvents < limit) break;
  }
  return { ok: true, deletedDeliveries, deletedRateEvents };
}
