import type { StartStoreResult } from "../../application/session-start-ports";
import { OwnershipLostFault } from "../../domain/ownership";
import { classifyDeliveryStorageError } from "./delivery-repository";

export function startOperationFailure(
  cause: unknown,
): Extract<StartStoreResult, { readonly ok: false }> {
  if (cause instanceof OwnershipLostFault) return { ok: false, code: "ownership_lost" };
  return { ok: false, code: classifyDeliveryStorageError(cause, () => false) };
}
