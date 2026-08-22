import { type DeliveryMetadata, isCoherentDeliveryMetadata } from "../domain/deliveries";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { admitClaimedMessage, deliveryStoreFailure } from "./admit-message-delivery";
import type {
  ClockPort,
  CurrentRootMembership,
  CurrentWorkspaceMembershipPort,
  DeliveryPersistencePort,
  NativeQueueAdmissionPort,
  OwnershipPort,
  RecoveryStartupBarrierPort,
  StartupRecoveryBarrier,
} from "./delivery-ports";

export interface MessageRecoveryPorts {
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly deliveries: DeliveryPersistencePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly startupBarrier: RecoveryStartupBarrierPort;
  readonly clock: ClockPort;
}

export interface MessageRecoverySummary {
  readonly submittingMarkedUnknown: number;
  readonly preparedSubmitted: number;
  readonly preparedCancelled: number;
}

function isRecoveryStopped(
  ports: MessageRecoveryPorts,
  abort: AbortSignal,
  deadlineMs: number | undefined,
): boolean {
  return abort.aborted || (deadlineMs !== undefined && ports.clock.nowMs() >= deadlineMs);
}

async function classifySubmittingBatch(
  ports: MessageRecoveryPorts,
  workspaceKey: WorkspaceKey,
  fencingToken: FencingToken,
  records: readonly DeliveryMetadata[],
  abort: AbortSignal,
  deadlineMs: number | undefined,
): Promise<DomainResult<number>> {
  let changed = 0;
  for (const delivery of records) {
    if (isRecoveryStopped(ports, abort, deadlineMs)) {
      return deliveryStoreFailure("ownership_lost", delivery.id);
    }
    if (!isCoherentDeliveryMetadata(delivery)) {
      return deliveryStoreFailure("state_conflict", delivery.id);
    }
    if (!(await ports.ownership.isCurrent(fencingToken))) {
      return deliveryStoreFailure("ownership_lost", delivery.id);
    }
    const result = await ports.deliveries.completeSubmission({
      fencingToken,
      workspaceKey,
      deliveryId: delivery.id,
      state: "admission_unknown",
      nowMs: ports.clock.nowMs(),
    });
    if (!result.ok) return deliveryStoreFailure(result.code, delivery.id);
    if (
      result.delivery.state !== "admission_unknown" ||
      !isCoherentDeliveryMetadata(result.delivery)
    ) {
      return deliveryStoreFailure("state_conflict", delivery.id);
    }
    changed += 1;
  }
  return { ok: true, value: changed };
}

async function markSubmittingUnknown(
  ports: MessageRecoveryPorts,
  workspaceKey: WorkspaceKey,
  fencingToken: FencingToken,
  startupBarrier: StartupRecoveryBarrier,
  abort: AbortSignal,
  deadlineMs: number | undefined,
  limit: number,
): Promise<DomainResult<number>> {
  let changed = 0;
  while (true) {
    if (isRecoveryStopped(ports, abort, deadlineMs)) return deliveryStoreFailure("ownership_lost");
    const records = await ports.deliveries.listRecoverable({
      fencingToken,
      workspaceKey,
      state: "submitting",
      limit,
      excludeClaimedByToken: fencingToken,
      startupBarrier,
    });
    if (records.length === 0) return { ok: true, value: changed };
    const batch = await classifySubmittingBatch(
      ports,
      workspaceKey,
      fencingToken,
      records,
      abort,
      deadlineMs,
    );
    if (!batch.ok) return batch;
    changed += batch.value;
  }
}

async function recoverPrepared(
  ports: MessageRecoveryPorts,
  workspaceKey: WorkspaceKey,
  fencingToken: FencingToken,
  abort: AbortSignal,
  deadlineMs: number | undefined,
  records: readonly DeliveryMetadata[],
): Promise<DomainResult<{ readonly submitted: number; readonly cancelled: number }>> {
  let submitted = 0;
  let cancelled = 0;
  for (const delivery of records) {
    if (isRecoveryStopped(ports, abort, deadlineMs)) {
      return deliveryStoreFailure("ownership_lost", delivery.id);
    }
    if (!isCoherentDeliveryMetadata(delivery)) {
      return deliveryStoreFailure("state_conflict", delivery.id);
    }
    const recovered = await recoverOnePrepared(
      ports,
      workspaceKey,
      fencingToken,
      abort,
      deadlineMs,
      delivery,
    );
    if (!recovered.ok) return recovered;
    if (recovered.value === "submitted") submitted += 1;
    if (recovered.value === "cancelled") cancelled += 1;
  }
  return { ok: true, value: { submitted, cancelled } };
}

async function readRecoveryMembership(
  ports: MessageRecoveryPorts,
  workspaceKey: WorkspaceKey,
  delivery: DeliveryMetadata,
): Promise<DomainResult<CurrentRootMembership>> {
  try {
    const value = await ports.membership.readCurrentRoots(
      workspaceKey,
      delivery.sourceSessionId,
      delivery.targetSessionId,
    );
    return { ok: true, value };
  } catch (_cause: unknown) {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
}

async function recoverOnePrepared(
  ports: MessageRecoveryPorts,
  workspaceKey: WorkspaceKey,
  fencingToken: FencingToken,
  abort: AbortSignal,
  deadlineMs: number | undefined,
  delivery: DeliveryMetadata,
): Promise<DomainResult<"submitted" | "cancelled" | "skipped">> {
  const membership = await readRecoveryMembership(ports, workspaceKey, delivery);
  if (!membership.ok) return membership;
  if (isRecoveryStopped(ports, abort, deadlineMs)) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  if (!(await ports.ownership.isCurrent(fencingToken))) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  if (isRecoveryStopped(ports, abort, deadlineMs)) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  if (!membership.value.sourceVisible || !membership.value.targetVisible) {
    const cancelled = await ports.deliveries.cancelPrepared({
      fencingToken,
      workspaceKey,
      deliveryId: delivery.id,
      nowMs: ports.clock.nowMs(),
    });
    return cancelled.ok
      ? { ok: true, value: "cancelled" }
      : deliveryStoreFailure(cancelled.code, delivery.id);
  }
  if (isRecoveryStopped(ports, abort, deadlineMs)) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  const claim = await ports.deliveries.claimPrepared({
    fencingToken,
    workspaceKey,
    deliveryId: delivery.id,
    nowMs: ports.clock.nowMs(),
  });
  if (!claim.ok) return deliveryStoreFailure(claim.code, delivery.id);
  if (!isCoherentDeliveryMetadata(claim.delivery)) {
    return deliveryStoreFailure("state_conflict", delivery.id);
  }
  if (claim.delivery.state !== "submitting" || claim.envelope === undefined) {
    return { ok: true, value: "skipped" };
  }
  if (isRecoveryStopped(ports, abort, deadlineMs)) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  if (!(await ports.ownership.isCurrent(fencingToken))) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  if (isRecoveryStopped(ports, abort, deadlineMs)) {
    return deliveryStoreFailure("ownership_lost", delivery.id);
  }
  const admission = await admitClaimedMessage(ports, {
    workspaceKey,
    fencingToken,
    delivery: claim.delivery,
    envelope: claim.envelope,
    abort,
    interruptionMeansOwnershipLoss: true,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  if (
    !admission.ok &&
    ["ownership_lost", "storage_unavailable", "state_conflict"].includes(admission.error.code)
  ) {
    return admission;
  }
  return { ok: true, value: "submitted" };
}

export async function recoverMessageDeliveries(
  ports: MessageRecoveryPorts,
  input: {
    readonly workspaceKey: WorkspaceKey;
    readonly abort: AbortSignal;
    readonly deadlineMs?: number;
    readonly limit: number;
  },
): Promise<DomainResult<MessageRecoverySummary>> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    return domainFailure(
      "invalid_arguments",
      "Recovery limit must be an integer from 1 to 100.",
      false,
    );
  }
  try {
    const fencingToken = await ports.ownership.acquire();
    const startupBarrier = await ports.startupBarrier.establish(fencingToken, {
      abort: input.abort,
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    });
    const ambiguous = await markSubmittingUnknown(
      ports,
      input.workspaceKey,
      fencingToken,
      startupBarrier,
      input.abort,
      input.deadlineMs,
      input.limit,
    );
    if (!ambiguous.ok) return ambiguous;
    if (
      input.abort.aborted ||
      (input.deadlineMs !== undefined && ports.clock.nowMs() >= input.deadlineMs)
    ) {
      return deliveryStoreFailure("ownership_lost");
    }
    const preparedRecords = await ports.deliveries.listRecoverable({
      fencingToken,
      workspaceKey: input.workspaceKey,
      state: "prepared",
      limit: input.limit,
    });
    // Prepared records contain the exact previously authorized envelope and matching digest. The
    // recovery pass does not broaden or repeat authorization; it may only claim that persisted input.
    const prepared = await recoverPrepared(
      ports,
      input.workspaceKey,
      fencingToken,
      input.abort,
      input.deadlineMs,
      preparedRecords,
    );
    if (!prepared.ok) return prepared;
    return {
      ok: true,
      value: {
        submittingMarkedUnknown: ambiguous.value,
        preparedSubmitted: prepared.value.submitted,
        preparedCancelled: prepared.value.cancelled,
      },
    };
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) return deliveryStoreFailure("ownership_lost");
    return domainFailure("storage_unavailable", "Delivery recovery storage is unavailable.", true);
  }
}
