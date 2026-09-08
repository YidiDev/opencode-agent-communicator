import type { StoreContext } from "./store-types";
import { StoreIntegrityError } from "./store-types";

/** Reads and validates the transactional wall clock trusted by persistence operations. */
export function storeNowMs(context: StoreContext): number {
  const nowMs = context.nowWallMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new StoreIntegrityError("The store clock was malformed.");
  }
  return nowMs;
}
