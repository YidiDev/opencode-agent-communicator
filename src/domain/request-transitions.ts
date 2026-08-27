import type {
  RequestDeliveryState,
  RequestKind,
  RequestMetadata,
  RequestResolutionState,
  RequestResultState,
} from "./request-types";
import { safeInteger } from "./request-validation";

const resolutionTransitions: Readonly<
  Record<RequestResolutionState, readonly RequestResolutionState[]>
> = {
  pending: [
    "answered",
    "reached",
    "deadline_expired",
    "cancelled",
    "delivery_failed",
    "target_stopped",
    "source_stopped",
    "target_deleted",
    "source_deleted",
  ],
  answered: [],
  reached: [],
  deadline_expired: [],
  cancelled: [],
  delivery_failed: [],
  target_stopped: [],
  source_stopped: [],
  target_deleted: [],
  source_deleted: [],
};

const deliveryTransitions: Readonly<Record<RequestDeliveryState, readonly RequestDeliveryState[]>> =
  {
    prepared: ["submitting"],
    submitting: ["delivery_unknown", "admitted", "promoted", "delivery_failed"],
    delivery_unknown: ["admitted", "promoted", "delivery_failed"],
    admitted: ["promoted"],
    promoted: [],
    delivery_failed: [],
  };

const resultTransitions: Readonly<Record<RequestResultState, readonly RequestResultState[]>> = {
  none: ["available"],
  available: ["expired", "acknowledged"],
  expired: ["acknowledged"],
  acknowledged: [],
};

export function canTransitionRequestResolution(
  from: RequestResolutionState,
  to: RequestResolutionState,
): boolean {
  // This describes ordering on one axis only. Successful persistence must use the composite helper.
  return resolutionTransitions[from].includes(to);
}

export function resolutionAppliesToRequestKind(
  kind: RequestKind,
  state: RequestResolutionState,
): boolean {
  return state !== "answered" && state !== "reached"
    ? true
    : (kind === "ask" && state === "answered") || (kind === "wait" && state === "reached");
}

export function canTransitionRequestDelivery(
  from: RequestDeliveryState,
  to: RequestDeliveryState,
): boolean {
  return deliveryTransitions[from].includes(to);
}

export function canTransitionRequestResult(
  from: RequestResultState,
  to: RequestResultState,
): boolean {
  // `none -> available` is coupled to successful resolution and is not a standalone store mutation.
  return resultTransitions[from].includes(to);
}

export const canTransitionRequestResultAvailability = canTransitionRequestResult;

function validTransitionInstant(metadata: RequestMetadata, atMs: unknown): atMs is number {
  return safeInteger(atMs) && atMs >= metadata.createdAtMs;
}

/**
 * Persistence must commit the successful resolution and available result in one mutation. Metadata
 * coherence does not authenticate a responder; storage must atomically bind target, workspace,
 * request, pending state, and the authoritative deadline.
 */
export function canAtomicallyAnswerWithAvailableResult(
  metadata: RequestMetadata,
  resolvedAtMs: unknown,
): boolean {
  return (
    metadata.kind === "ask" &&
    metadata.resolutionState === "pending" &&
    validTransitionInstant(metadata, resolvedAtMs) &&
    resolvedAtMs < metadata.deadlineAtMs
  );
}

export function canAtomicallyReachWithAvailableResult(
  metadata: RequestMetadata,
  resolvedAtMs: unknown,
): boolean {
  return (
    metadata.kind === "wait" &&
    metadata.resolutionState === "pending" &&
    validTransitionInstant(metadata, resolvedAtMs) &&
    resolvedAtMs < metadata.deadlineAtMs
  );
}

function latestDeliveryTransitionAtMs(metadata: RequestMetadata): number {
  // The transition guard immediately before this call permits only submitting and unknown.
  // Keeping terminal-state handling here made unreachable branches look like supported failure
  // transitions and obscured that invariant.
  const transition = metadata as Extract<
    RequestMetadata,
    { readonly deliveryState: "submitting" | "delivery_unknown" }
  >;
  return transition.deliveryState === "delivery_unknown"
    ? transition.deliveryUnknownAtMs
    : transition.submittedAtMs;
}

export function canAtomicallyFailPendingRequestDelivery(
  metadata: RequestMetadata,
  failedAtMs: unknown,
): boolean {
  return (
    metadata.resolutionState === "pending" &&
    canTransitionRequestDelivery(metadata.deliveryState, "delivery_failed") &&
    validTransitionInstant(metadata, failedAtMs) &&
    failedAtMs >= latestDeliveryTransitionAtMs(metadata) &&
    failedAtMs < metadata.deadlineAtMs
  );
}

export function canExpireAvailableRequestResult(
  metadata: RequestMetadata,
  expiredAtMs: unknown,
): boolean {
  return (
    metadata.resultState === "available" &&
    validTransitionInstant(metadata, expiredAtMs) &&
    expiredAtMs >= metadata.resultExpiresAtMs
  );
}

export function canAcknowledgeRequestResult(
  metadata: RequestMetadata,
  acknowledgedAtMs: unknown,
): boolean {
  if (!validTransitionInstant(metadata, acknowledgedAtMs)) return false;
  if (metadata.resultState === "available") {
    return acknowledgedAtMs >= metadata.resultAvailableAtMs;
  }
  return metadata.resultState === "expired" && acknowledgedAtMs >= metadata.resultExpiredAtMs;
}
