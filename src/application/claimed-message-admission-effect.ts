import type { DeliveryMetadata } from "../domain/deliveries";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import type { DomainResult } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { boundedExternalCall } from "./bounded-external-call";
import {
  claimedAdmissionUnknown,
  deadlineLinkedSignal,
  deliveryStoreFailure,
  inspectNativeAdmission,
  isDurablyRecordedOutcome,
  type MessageAdmissionPorts,
  recordOutcome,
} from "./claimed-message-admission";
import type { NativeQueueAdmission } from "./delivery-ports";
import { operationControlStopped } from "./safe-clock";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear claimed-effect boundary preserves exact interruption and ownership-fault mappings.
export async function admitClaimedMessage(
  ports: MessageAdmissionPorts,
  input: {
    readonly workspaceKey: WorkspaceKey;
    readonly fencingToken: FencingToken;
    readonly delivery: DeliveryMetadata;
    readonly envelope: string;
    readonly abort: AbortSignal;
    readonly deadlineMs?: number;
    readonly interruptionMeansOwnershipLoss?: true;
  },
): Promise<DomainResult<DeliveryMetadata>> {
  const recovery = input.interruptionMeansOwnershipLoss === true;
  const durableOperationSignal = recovery ? input.abort : new AbortController().signal;
  const stopped = (): boolean =>
    recovery && operationControlStopped(ports.clock, input.abort, input.deadlineMs);
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  const bounded = <Value>(operation: () => Promise<Value>) =>
    recovery
      ? runUntilAborted(durableOperationSignal, operation)
      : input.deadlineMs === undefined
        ? runUntilAborted(input.abort, operation)
        : boundedExternalCall(operation, input.abort, input.deadlineMs).then((result) =>
            result.kind === "value"
              ? { kind: "settled" as const, value: result.value }
              : result.kind === "rejected"
                ? { kind: "rejected" as const, cause: result.cause }
                : { kind: "aborted" as const },
          );
  const recordUnknownWithoutWaiting = (): void => {
    recordOutcome(
      ports,
      input.workspaceKey,
      input.fencingToken,
      input.delivery.id,
      { kind: "unknown" },
      new AbortController().signal,
      undefined,
    ).catch(() => undefined);
  };
  const current = await bounded(() => ports.ownership.isCurrent(input.fencingToken));
  if (current.kind === "aborted" && !recovery) {
    recordUnknownWithoutWaiting();
    return claimedAdmissionUnknown(input.delivery.id);
  }
  if (current.kind === "aborted" || (current.kind === "settled" && current.value !== true))
    return deliveryStoreFailure("ownership_lost", input.delivery.id);
  if (current.kind === "rejected")
    return deliveryStoreFailure(
      current.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      input.delivery.id,
    );
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  let outcome: NativeQueueAdmission;
  if (recovery) {
    try {
      const promise = ports.nativeQueue.queueMessage({
        targetSessionId: input.delivery.targetSessionId,
        nativeMessageId: input.delivery.nativeMessageId,
        envelope: input.envelope,
        abort: input.abort,
      });
      const settlement = await runUntilAborted(input.abort, () => promise);
      if (
        settlement.kind === "aborted" ||
        (settlement.kind === "rejected" && settlement.cause instanceof OwnershipLostFault)
      )
        return deliveryStoreFailure("ownership_lost", input.delivery.id);
      outcome = settlement.kind === "settled" ? settlement.value : { kind: "unknown" };
    } catch (cause: unknown) {
      if (cause instanceof OwnershipLostFault)
        return deliveryStoreFailure("ownership_lost", input.delivery.id);
      outcome = { kind: "unknown" };
    }
  } else {
    const effect =
      input.deadlineMs === undefined
        ? { signal: input.abort, dispose() {} }
        : deadlineLinkedSignal(input.abort, input.deadlineMs);
    try {
      const settlement = await runUntilAborted(effect.signal, () =>
        ports.nativeQueue.queueMessage({
          targetSessionId: input.delivery.targetSessionId,
          nativeMessageId: input.delivery.nativeMessageId,
          envelope: input.envelope,
          abort: effect.signal,
        }),
      );
      if (settlement.kind !== "settled") {
        recordUnknownWithoutWaiting();
        return claimedAdmissionUnknown(input.delivery.id);
      }
      outcome = inspectNativeAdmission(settlement.value);
    } finally {
      effect.dispose();
    }
  }
  outcome = inspectNativeAdmission(outcome);
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  if (
    !recovery &&
    (input.abort.aborted || (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs))
  ) {
    recordUnknownWithoutWaiting();
    return claimedAdmissionUnknown(input.delivery.id);
  }
  const currentAfterEffect = await bounded(() => ports.ownership.isCurrent(input.fencingToken));
  if (currentAfterEffect.kind === "aborted" && !recovery) {
    recordUnknownWithoutWaiting();
    return claimedAdmissionUnknown(input.delivery.id);
  }
  if (
    currentAfterEffect.kind === "aborted" ||
    (currentAfterEffect.kind === "settled" && currentAfterEffect.value !== true)
  ) {
    if (!recovery) {
      recordUnknownWithoutWaiting();
      return claimedAdmissionUnknown(input.delivery.id);
    }
    return deliveryStoreFailure("ownership_lost", input.delivery.id);
  }
  if (currentAfterEffect.kind === "rejected") {
    if (!recovery) {
      recordUnknownWithoutWaiting();
      return claimedAdmissionUnknown(input.delivery.id);
    }
    return deliveryStoreFailure(
      currentAfterEffect.cause instanceof OwnershipLostFault
        ? "ownership_lost"
        : "storage_unavailable",
      input.delivery.id,
    );
  }
  const record = () =>
    recordOutcome(
      ports,
      input.workspaceKey,
      input.fencingToken,
      input.delivery.id,
      outcome,
      durableOperationSignal,
      recovery ? input.deadlineMs : undefined,
    );
  if (recovery) return record();
  if (input.deadlineMs === undefined) {
    const recorded = await runUntilAborted(input.abort, record);
    if (recorded.kind !== "settled") {
      if (recorded.kind === "rejected") recordUnknownWithoutWaiting();
      return claimedAdmissionUnknown(input.delivery.id);
    }
    if (isDurablyRecordedOutcome(recorded.value)) return recorded.value;
    recordUnknownWithoutWaiting();
    return claimedAdmissionUnknown(input.delivery.id);
  }
  const recorded = await boundedExternalCall(record, input.abort, input.deadlineMs);
  if (recorded.kind === "value") {
    if (isDurablyRecordedOutcome(recorded.value)) return recorded.value;
    recordUnknownWithoutWaiting();
    return claimedAdmissionUnknown(input.delivery.id);
  }
  if (recorded.kind === "rejected") recordUnknownWithoutWaiting();
  return claimedAdmissionUnknown(input.delivery.id);
}
