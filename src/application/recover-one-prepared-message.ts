import { type DeliveryMetadata, isCoherentDeliveryMetadata } from "../domain/deliveries";
import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { admitClaimedMessage, deliveryStoreFailure } from "./admit-message-delivery";
import type { CurrentRootMembership, MessageRecoveryPorts } from "./delivery-ports";
import { inspectDeliveryMutation, inspectMembership } from "./message-recovery-boundaries";
import { operationControlStopped, readSafeClockMs } from "./safe-clock";

function sameIdentity(before: DeliveryMetadata, after: DeliveryMetadata): boolean {
  return (
    before.id === after.id &&
    before.workspaceKey === after.workspaceKey &&
    before.sourceSessionId === after.sourceSessionId &&
    before.targetSessionId === after.targetSessionId &&
    before.nativeMessageId === after.nativeMessageId &&
    before.contentByteLength === after.contentByteLength &&
    before.contentSha256 === after.contentSha256 &&
    before.createdAtMs === after.createdAtMs
  );
}

async function readMembership(
  ports: MessageRecoveryPorts,
  workspaceKey: WorkspaceKey,
  delivery: DeliveryMetadata,
  abort: AbortSignal,
): Promise<DomainResult<CurrentRootMembership>> {
  const settlement = await runUntilAborted(abort, () =>
    ports.membership.readCurrentRoots(
      workspaceKey,
      delivery.sourceSessionId,
      delivery.targetSessionId,
    ),
  );
  if (settlement.kind === "aborted") return deliveryStoreFailure("ownership_lost", delivery.id);
  if (settlement.kind === "rejected") {
    return settlement.cause instanceof OwnershipLostFault
      ? deliveryStoreFailure("ownership_lost", delivery.id)
      : domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  const membership = inspectMembership(settlement.value);
  return membership
    ? { ok: true, value: membership }
    : domainFailure("native_unavailable", "Current session membership is malformed.", true);
}

async function cancelInvisible(
  ports: MessageRecoveryPorts,
  workspaceKey: WorkspaceKey,
  fencingToken: FencingToken,
  delivery: DeliveryMetadata,
  abort: AbortSignal,
  deadlineMs: number | undefined,
): Promise<DomainResult<"cancelled">> {
  const nowMs = readSafeClockMs(ports.clock);
  if (nowMs === undefined || operationControlStopped(ports.clock, abort, deadlineMs)) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  const settlement = await runUntilAborted(abort, () =>
    ports.deliveries.cancelPrepared({ fencingToken, workspaceKey, deliveryId: delivery.id, nowMs }),
  );
  if (settlement.kind === "aborted") return deliveryStoreFailure("ownership_lost", delivery.id);
  if (settlement.kind === "rejected") {
    return deliveryStoreFailure(
      settlement.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      delivery.id,
    );
  }
  const cancelled = inspectDeliveryMutation(settlement.value);
  if (!cancelled) return deliveryStoreFailure("state_conflict", delivery.id);
  if (!cancelled.ok) return deliveryStoreFailure(cancelled.code, delivery.id);
  return isCoherentDeliveryMetadata(cancelled.delivery) &&
    cancelled.delivery.state === "cancelled" &&
    sameIdentity(delivery, cancelled.delivery)
    ? { ok: true, value: "cancelled" }
    : deliveryStoreFailure("state_conflict", delivery.id);
}

function ownershipFailure(cause: unknown, delivery: DeliveryMetadata): DomainResult<never> {
  return deliveryStoreFailure(
    cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    delivery.id,
  );
}

export function interpretRecoveredMessageAdmission(
  admission: DomainResult<DeliveryMetadata>,
): DomainResult<"submitted"> {
  if (admission.ok) return { ok: true, value: "submitted" };
  // These two domain failures prove their corresponding post-effect store transition committed.
  // Every other failure can leave this token's claim in `submitting`, so startup must fail closed.
  return admission.error.code === "admission_unknown" || admission.error.code === "admission_failed"
    ? { ok: true, value: "submitted" }
    : admission;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recovery preserves the exact observe, fence, claim, refence, and effect sequence.
export async function recoverOnePreparedMessage(
  ports: MessageRecoveryPorts,
  workspaceKey: WorkspaceKey,
  fencingToken: FencingToken,
  abort: AbortSignal,
  deadlineMs: number | undefined,
  delivery: DeliveryMetadata,
): Promise<DomainResult<"submitted" | "cancelled" | "skipped">> {
  const stopped = (): boolean => operationControlStopped(ports.clock, abort, deadlineMs);
  const membership = await readMembership(ports, workspaceKey, delivery, abort);
  if (!membership.ok) return membership;
  if (stopped()) return deliveryStoreFailure("ownership_lost", delivery.id);
  const current = await runUntilAborted(abort, () => ports.ownership.isCurrent(fencingToken));
  if (current.kind === "aborted" || (current.kind === "settled" && current.value !== true)) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  if (current.kind === "rejected") return ownershipFailure(current.cause, delivery);
  if (stopped()) return deliveryStoreFailure("ownership_lost", delivery.id);
  if (!membership.value.sourceVisible || !membership.value.targetVisible) {
    return cancelInvisible(ports, workspaceKey, fencingToken, delivery, abort, deadlineMs);
  }
  const nowMs = readSafeClockMs(ports.clock);
  if (nowMs === undefined || stopped()) return deliveryStoreFailure("ownership_lost", delivery.id);
  const claimSettlement = await runUntilAborted(abort, () =>
    ports.deliveries.claimPrepared({ fencingToken, workspaceKey, deliveryId: delivery.id, nowMs }),
  );
  if (claimSettlement.kind === "aborted")
    return deliveryStoreFailure("ownership_lost", delivery.id);
  if (claimSettlement.kind === "rejected") return ownershipFailure(claimSettlement.cause, delivery);
  const claim = inspectDeliveryMutation(claimSettlement.value);
  if (!claim) return deliveryStoreFailure("state_conflict", delivery.id);
  if (!claim.ok) return deliveryStoreFailure(claim.code, delivery.id);
  if (!isCoherentDeliveryMetadata(claim.delivery) || !sameIdentity(delivery, claim.delivery)) {
    return deliveryStoreFailure("state_conflict", delivery.id);
  }
  if (claim.delivery.state !== "submitting" || claim.envelope === undefined) {
    return { ok: true, value: "skipped" };
  }
  if (stopped()) return deliveryStoreFailure("ownership_lost", delivery.id);
  const currentAfterClaim = await runUntilAborted(abort, () =>
    ports.ownership.isCurrent(fencingToken),
  );
  if (
    currentAfterClaim.kind === "aborted" ||
    (currentAfterClaim.kind === "settled" && currentAfterClaim.value !== true)
  ) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  if (currentAfterClaim.kind === "rejected") {
    return ownershipFailure(currentAfterClaim.cause, delivery);
  }
  if (stopped()) return deliveryStoreFailure("ownership_lost", delivery.id);
  const admission = await admitClaimedMessage(ports, {
    workspaceKey,
    fencingToken,
    delivery: claim.delivery,
    envelope: claim.envelope,
    abort,
    interruptionMeansOwnershipLoss: true,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  return interpretRecoveredMessageAdmission(admission);
}
