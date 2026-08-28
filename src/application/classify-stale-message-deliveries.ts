import { type DeliveryMetadata, isCoherentDeliveryMetadata } from "../domain/deliveries";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { deliveryRecordsPerWorkspaceHardCeiling } from "../domain/safety-ceilings";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { deliveryStoreFailure } from "./admit-message-delivery";
import type { MessageRecoveryPorts, StartupRecoveryBarrier } from "./delivery-ports";
import { inspectDeliveryMetadata, inspectDeliveryMutation } from "./message-recovery-boundaries";
import type { MessageRecoveryPhaseInput } from "./message-recovery-phase-types";
import { operationControlStopped, readSafeClockMs } from "./safe-clock";
import { snapshotDenseArray } from "./strict-port-boundaries";

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

function inspectDeliveryBatch(
  records: readonly unknown[],
  seen: Set<string>,
): DeliveryMetadata[] | undefined {
  const coherent: DeliveryMetadata[] = [];
  for (const raw of records) {
    const delivery = inspectDeliveryMetadata(raw);
    if (!delivery || seen.has(delivery.id)) return undefined;
    seen.add(delivery.id);
    coherent.push(delivery);
  }
  return coherent;
}

function sameDeliveryIdentity(before: DeliveryMetadata, after: DeliveryMetadata): boolean {
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each settlement is mapped at its mutation boundary.
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
    if (operationControlStopped(ports.clock, abort, deadlineMs)) {
      return deliveryStoreFailure("ownership_lost", delivery.id);
    }
    if (!isCoherentDeliveryMetadata(delivery)) {
      return deliveryStoreFailure("state_conflict", delivery.id);
    }
    const current = await runUntilAborted(abort, () => ports.ownership.isCurrent(fencingToken));
    if (current.kind === "aborted" || (current.kind === "settled" && current.value !== true)) {
      return deliveryStoreFailure("ownership_lost", delivery.id);
    }
    if (current.kind === "rejected") {
      return deliveryStoreFailure(
        current.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        delivery.id,
      );
    }
    const nowMs = readSafeClockMs(ports.clock);
    if (nowMs === undefined || operationControlStopped(ports.clock, abort, deadlineMs)) {
      return deliveryStoreFailure("ownership_lost", delivery.id);
    }
    const settled = await runUntilAborted(abort, () =>
      ports.deliveries.completeSubmission({
        fencingToken,
        workspaceKey,
        deliveryId: delivery.id,
        state: "admission_unknown",
        nowMs,
      }),
    );
    if (settled.kind === "aborted") return deliveryStoreFailure("ownership_lost", delivery.id);
    if (settled.kind === "rejected") {
      return deliveryStoreFailure(
        settled.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        delivery.id,
      );
    }
    const result = inspectDeliveryMutation(settled.value);
    if (!result?.ok) {
      return result
        ? deliveryStoreFailure(result.code, delivery.id)
        : deliveryStoreFailure("state_conflict", delivery.id);
    }
    if (
      result.delivery.state !== "admission_unknown" ||
      !isCoherentDeliveryMetadata(result.delivery) ||
      !sameDeliveryIdentity(delivery, result.delivery)
    ) {
      return deliveryStoreFailure("state_conflict", delivery.id);
    }
    changed += 1;
  }
  return { ok: true, value: changed };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the bounded traversal keeps its ceiling and residual probe together.
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
  const seen = new Set<string>();
  while (true) {
    if (operationControlStopped(ports.clock, abort, deadlineMs)) {
      return deliveryStoreFailure("ownership_lost");
    }
    const remaining = deliveryRecordsPerWorkspaceHardCeiling - seen.size;
    const batchLimit = Math.min(limit, remaining);
    const listed = await runUntilAborted(abort, () =>
      ports.deliveries.listRecoverable({
        fencingToken,
        workspaceKey,
        state: "submitting",
        limit: batchLimit,
        excludeClaimedByToken: fencingToken,
        startupBarrier,
      }),
    );
    if (listed.kind === "aborted") return deliveryStoreFailure("ownership_lost");
    if (listed.kind === "rejected") {
      return deliveryStoreFailure(
        listed.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      );
    }
    const batchRecords = snapshotDenseArray(listed.value, batchLimit);
    if (!batchRecords) return deliveryStoreFailure("state_conflict");
    if (batchRecords.length === 0) return { ok: true, value: changed };
    const coherentRecords = inspectDeliveryBatch(batchRecords, seen);
    if (!coherentRecords) return deliveryStoreFailure("state_conflict");
    const batch = await classifySubmittingBatch(
      ports,
      workspaceKey,
      fencingToken,
      coherentRecords,
      abort,
      deadlineMs,
    );
    if (!batch.ok) return batch;
    changed += batch.value;
    if (seen.size === deliveryRecordsPerWorkspaceHardCeiling) {
      const residual = await runUntilAborted(abort, () =>
        ports.deliveries.listRecoverable({
          fencingToken,
          workspaceKey,
          state: "submitting",
          limit: 1,
          excludeClaimedByToken: fencingToken,
          startupBarrier,
        }),
      );
      if (residual.kind === "aborted") return deliveryStoreFailure("ownership_lost");
      if (residual.kind === "rejected") {
        return deliveryStoreFailure(
          residual.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        );
      }
      const snapshot = snapshotDenseArray(residual.value, 1);
      if (snapshot?.length !== 0) return deliveryStoreFailure("state_conflict");
      return { ok: true, value: changed };
    }
  }
}

export async function classifyStaleMessageDeliveries(
  ports: MessageRecoveryPorts,
  input: MessageRecoveryPhaseInput,
): Promise<DomainResult<number>> {
  if (!validPhaseInput(input)) {
    return domainFailure("invalid_arguments", "Message recovery phase input is invalid.", false);
  }
  if (input.startupBarrier.fencingToken !== input.fencingToken) {
    return deliveryStoreFailure("ownership_lost");
  }
  return markSubmittingUnknown(
    ports,
    input.workspaceKey,
    input.fencingToken,
    input.startupBarrier,
    input.abort,
    input.deadlineMs,
    input.limit,
  );
}
