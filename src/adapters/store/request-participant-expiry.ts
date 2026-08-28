import type { RequestMetadata } from "../../domain/request-types";
import type { RequestRepository } from "./request-repository";
import type { RequestResultRetentionRepository } from "./request-result-retention-repository";
import { type StoreContext, StoreIntegrityError, sqliteStoreHardCeilings } from "./store-types";

function drain(
  ceiling: number,
  message: string,
  expire: () => RequestMetadata[],
): RequestMetadata[] {
  const terminalized: RequestMetadata[] = [];
  const maximumBatches = Math.ceil(ceiling / 100) + 1;
  for (let batch = 0; batch < maximumBatches; batch++) {
    const items = expire();
    terminalized.push(...items);
    if (items.length < 100) return terminalized;
  }
  throw new StoreIntegrityError(message);
}

export function drainDueParticipantRequests(
  context: StoreContext,
  requests: RequestRepository,
  caller: string,
  nowMs: number,
  role: "source" | "target",
): RequestMetadata[] {
  const ceiling =
    role === "source"
      ? sqliteStoreHardCeilings.pendingRequestsPerSource
      : sqliteStoreHardCeilings.pendingRequestsPerTarget;
  const label = role === "source" ? "Source" : "Target";
  return drain(ceiling, `${label} request expiry exceeded its hard bound.`, () =>
    role === "source"
      ? requests.expireDueForSourceOwned(context.workspaceKey, caller, nowMs, 100)
      : requests.expireDueForTargetOwned(context.workspaceKey, caller, nowMs, 100),
  );
}

export function drainDueParticipantResults(
  context: StoreContext,
  results: RequestResultRetentionRepository,
  caller: string,
  nowMs: number,
): RequestMetadata[] {
  return drain(
    sqliteStoreHardCeilings.availableResultsPerSource,
    "Source result expiry exceeded its hard bound.",
    () => results.expireAvailableForSourceOwned(context.workspaceKey, caller, nowMs, 100),
  );
}
