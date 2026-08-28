import { type DeliveryMetadata, isCoherentDeliveryMetadata } from "../domain/deliveries";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { deliveryRecordsPerWorkspaceHardCeiling } from "../domain/safety-ceilings";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { deliveryStoreFailure } from "./admit-message-delivery";
import type { MessageRecoveryPorts } from "./delivery-ports";
import { inspectDeliveryMetadata } from "./message-recovery-boundaries";
import type { MessageRecoveryPhaseInput } from "./message-recovery-phase-types";
import { recoverOnePreparedMessage } from "./recover-one-prepared-message";
import { operationControlStopped } from "./safe-clock";
import { snapshotDenseArray } from "./strict-port-boundaries";

export { classifyStaleMessageDeliveries } from "./classify-stale-message-deliveries";
export type { MessageRecoveryPorts, MessageRecoverySummary } from "./delivery-ports";
export type { MessageRecoveryPhaseInput } from "./message-recovery-phase-types";

export const startupRecoveryMaximumRecords = deliveryRecordsPerWorkspaceHardCeiling;

function validPhaseInput(input: MessageRecoveryPhaseInput): boolean {
  return (
    Number.isSafeInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= 100 &&
    typeof input.abort === "object" &&
    input.abort !== null &&
    typeof input.abort.aborted === "boolean" &&
    (input.deadlineMs === undefined ||
      (Number.isSafeInteger(input.deadlineMs) && input.deadlineMs >= 0))
  );
}

function isRecoveryStopped(
  ports: MessageRecoveryPorts,
  abort: AbortSignal,
  deadlineMs: number | undefined,
): boolean {
  return operationControlStopped(ports.clock, abort, deadlineMs);
}

function inspectDeliveryBatch(
  records: readonly unknown[],
  seen: Set<string>,
): DeliveryMetadata[] | undefined {
  const coherent: DeliveryMetadata[] = [];
  for (const raw of records) {
    const delivery = inspectDeliveryMetadata(raw);
    if (!delivery) return undefined;
    if (seen.has(delivery.id)) return undefined;
    seen.add(delivery.id);
    coherent.push(delivery);
  }
  return coherent;
}

async function recoveryExhausted(
  abort: AbortSignal,
  probe: () => Promise<readonly DeliveryMetadata[]>,
): Promise<DomainResult<boolean>> {
  const settlement = await runUntilAborted(abort, probe);
  if (settlement.kind === "aborted") return deliveryStoreFailure("ownership_lost");
  if (settlement.kind === "rejected") {
    return deliveryStoreFailure(
      settlement.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
  const snapshot = snapshotDenseArray(settlement.value, 1);
  return snapshot
    ? { ok: true, value: snapshot.length === 0 }
    : deliveryStoreFailure("state_conflict");
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
    const recovered = await recoverOnePreparedMessage(
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one keyset traversal makes the hard ceiling and final residual probe reviewable together.
export async function recoverPreparedMessageDeliveries(
  ports: MessageRecoveryPorts,
  input: MessageRecoveryPhaseInput,
): Promise<DomainResult<{ readonly submitted: number; readonly cancelled: number }>> {
  if (!validPhaseInput(input)) {
    return domainFailure("invalid_arguments", "Message recovery phase input is invalid.", false);
  }
  if (input.startupBarrier.fencingToken !== input.fencingToken) {
    return deliveryStoreFailure("ownership_lost");
  }
  let submitted = 0;
  let cancelled = 0;
  const seen = new Set<string>();
  let cursor:
    | Readonly<{ readonly createdAtMs: number; readonly id: DeliveryMetadata["id"] }>
    | undefined;
  while (true) {
    if (isRecoveryStopped(ports, input.abort, input.deadlineMs)) {
      return deliveryStoreFailure("ownership_lost");
    }
    if (seen.size === startupRecoveryMaximumRecords) {
      const exhausted = await recoveryExhausted(input.abort, () =>
        ports.deliveries.listRecoverable({
          fencingToken: input.fencingToken,
          workspaceKey: input.workspaceKey,
          state: "prepared",
          limit: 1,
        }),
      );
      if (!exhausted.ok) return exhausted;
      return exhausted.value
        ? { ok: true, value: { submitted, cancelled } }
        : deliveryStoreFailure("state_conflict");
    }
    const remaining = startupRecoveryMaximumRecords - seen.size;
    const batchLimit = Math.min(input.limit, remaining);
    const listed = await runUntilAborted(input.abort, () =>
      ports.deliveries.listRecoverable({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        state: "prepared",
        limit: batchLimit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (listed.kind === "aborted") return deliveryStoreFailure("ownership_lost");
    if (listed.kind === "rejected") {
      return deliveryStoreFailure(
        listed.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      );
    }
    const records = listed.value;
    const batchRecords = snapshotDenseArray(records, batchLimit);
    if (!batchRecords) {
      return deliveryStoreFailure("state_conflict");
    }
    if (batchRecords.length === 0) {
      const exhausted = await recoveryExhausted(input.abort, () =>
        ports.deliveries.listRecoverable({
          fencingToken: input.fencingToken,
          workspaceKey: input.workspaceKey,
          state: "prepared",
          limit: 1,
        }),
      );
      if (!exhausted.ok) return exhausted;
      return exhausted.value
        ? { ok: true, value: { submitted, cancelled } }
        : deliveryStoreFailure("state_conflict");
    }
    const coherentRecords = inspectDeliveryBatch(batchRecords, seen);
    if (!coherentRecords) return deliveryStoreFailure("state_conflict");
    for (const delivery of coherentRecords) {
      if (
        cursor &&
        (delivery.createdAtMs < cursor.createdAtMs ||
          (delivery.createdAtMs === cursor.createdAtMs && delivery.id <= cursor.id))
      ) {
        return deliveryStoreFailure("state_conflict", delivery.id);
      }
      cursor = Object.freeze({ createdAtMs: delivery.createdAtMs, id: delivery.id });
    }
    const recovered = await recoverPrepared(
      ports,
      input.workspaceKey,
      input.fencingToken,
      input.abort,
      input.deadlineMs,
      coherentRecords,
    );
    if (!recovered.ok) return recovered;
    submitted += recovered.value.submitted;
    cancelled += recovered.value.cancelled;
  }
}
