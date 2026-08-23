import { type DeliveryMetadata, isCoherentDeliveryMetadata } from "../domain/deliveries";
import type { DeliveryId } from "../domain/generated-ids";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import type {
  ClockPort,
  DeliveryPersistencePort,
  DeliveryStoreFailureCode,
  DeliveryStoreResult,
  NativeQueueAdmission,
  NativeQueueAdmissionPort,
  OwnershipPort,
} from "./delivery-ports";
import { inspectDeliveryMutation } from "./message-recovery-boundaries";
import { operationControlStopped, readSafeClockMs } from "./safe-clock";

export interface MessageAdmissionPorts {
  readonly deliveries: DeliveryPersistencePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly clock: ClockPort;
}

export function deliveryStoreFailure(
  code: DeliveryStoreFailureCode,
  deliveryId?: DeliveryId,
): DomainResult<never> {
  const messages: Readonly<Record<DeliveryStoreFailureCode, string>> = {
    quota_exceeded: "Message or delivery quota is exhausted.",
    rate_limited: "Message admission rate is limited.",
    ownership_lost: "Coordinator ownership was lost.",
    state_conflict: "Delivery state changed concurrently.",
    storage_unavailable: "Delivery storage is unavailable.",
  };
  return deliveryId === undefined
    ? domainFailure(code, messages[code], code === "rate_limited" || code === "storage_unavailable")
    : domainFailure(
        code,
        messages[code],
        code === "rate_limited" || code === "storage_unavailable",
        {
          delivery_id: deliveryId,
        },
      );
}

function admissionResult(
  outcome: NativeQueueAdmission,
  write: DeliveryStoreResult,
): DomainResult<DeliveryMetadata> {
  if (!write.ok) return deliveryStoreFailure(write.code);
  if (!isCoherentDeliveryMetadata(write.delivery)) {
    return deliveryStoreFailure("state_conflict", write.delivery.id);
  }
  if (outcome.kind === "definitive_rejection") {
    return domainFailure("admission_failed", "Native queue admission was rejected.", false, {
      delivery_id: write.delivery.id,
    });
  }
  if (outcome.kind === "unknown") {
    return domainFailure(
      "admission_unknown",
      "Native queue admission could not be determined.",
      false,
      { delivery_id: write.delivery.id },
    );
  }
  return { ok: true, value: write.delivery };
}

function isCoherent(outcome: NativeQueueAdmission): boolean {
  if (outcome.kind !== "admitted" && outcome.kind !== "promoted") return true;
  if (!Number.isSafeInteger(outcome.admittedSeq) || outcome.admittedSeq < 0) return false;
  if (!Number.isFinite(outcome.observedAtMs) || outcome.observedAtMs < 0) return false;
  return (
    outcome.kind === "admitted" ||
    (Number.isSafeInteger(outcome.promotedSeq) && outcome.promotedSeq > outcome.admittedSeq)
  );
}

async function recordOutcome(
  ports: MessageAdmissionPorts,
  workspaceKey: WorkspaceKey,
  fencingToken: FencingToken,
  deliveryId: DeliveryMetadata["id"],
  outcome: NativeQueueAdmission,
  abort: AbortSignal,
  deadlineMs: number | undefined,
): Promise<DomainResult<DeliveryMetadata>> {
  if (!isCoherent(outcome)) outcome = { kind: "unknown" };
  const nowMs = readSafeClockMs(ports.clock);
  if (nowMs === undefined || operationControlStopped(ports.clock, abort, deadlineMs)) {
    return deliveryStoreFailure("ownership_lost", deliveryId);
  }
  let write: () => Promise<DeliveryStoreResult>;
  if (outcome.kind === "promoted") {
    write = () =>
      ports.deliveries.completeSubmission({
        fencingToken,
        workspaceKey,
        deliveryId,
        state: "promoted",
        nowMs,
        admittedSeq: outcome.admittedSeq,
        promotedSeq: outcome.promotedSeq,
        evidenceObservedAtMs: outcome.observedAtMs,
      });
  } else {
    write =
      outcome.kind === "admitted"
        ? () =>
            ports.deliveries.completeSubmission({
              workspaceKey,
              fencingToken,
              deliveryId,
              state: "admitted",
              nowMs,
              admittedSeq: outcome.admittedSeq,
              evidenceObservedAtMs: outcome.observedAtMs,
            })
        : () =>
            ports.deliveries.completeSubmission({
              workspaceKey,
              fencingToken,
              deliveryId,
              state: outcome.kind === "definitive_rejection" ? "failed" : "admission_unknown",
              nowMs,
            });
  }
  const settlement = await runUntilAborted(abort, write);
  if (settlement.kind === "aborted") return deliveryStoreFailure("ownership_lost", deliveryId);
  if (settlement.kind === "rejected") {
    return deliveryStoreFailure(
      settlement.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      deliveryId,
    );
  }
  const result = inspectDeliveryMutation(settlement.value);
  if (!result) return deliveryStoreFailure("state_conflict", deliveryId);
  return result.ok
    ? admissionResult(outcome, result)
    : deliveryStoreFailure(result.code, deliveryId);
}

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
    /** Recovery must stop rather than report success when its startup control is interrupted. */
    readonly interruptionMeansOwnershipLoss?: true;
  },
): Promise<DomainResult<DeliveryMetadata>> {
  const durableOperationSignal =
    input.interruptionMeansOwnershipLoss === true ? input.abort : new AbortController().signal;
  const stopped = (): boolean =>
    input.interruptionMeansOwnershipLoss === true &&
    operationControlStopped(ports.clock, input.abort, input.deadlineMs);
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  const current = await runUntilAborted(durableOperationSignal, () =>
    ports.ownership.isCurrent(input.fencingToken),
  );
  if (current.kind === "aborted" || (current.kind === "settled" && current.value !== true)) {
    return deliveryStoreFailure("ownership_lost", input.delivery.id);
  }
  if (current.kind === "rejected") {
    return deliveryStoreFailure(
      current.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      input.delivery.id,
    );
  }
  // No awaited work is allowed between this final control check and the native effect.
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  let outcome: NativeQueueAdmission;
  try {
    const promise = ports.nativeQueue.queueMessage({
      targetSessionId: input.delivery.targetSessionId,
      nativeMessageId: input.delivery.nativeMessageId,
      envelope: input.envelope,
      abort: input.abort,
    });
    if (input.interruptionMeansOwnershipLoss === true) {
      const settlement = await runUntilAborted(input.abort, () => promise);
      if (settlement.kind === "aborted") {
        return deliveryStoreFailure("ownership_lost", input.delivery.id);
      }
      if (settlement.kind === "rejected" && settlement.cause instanceof OwnershipLostFault) {
        return deliveryStoreFailure("ownership_lost", input.delivery.id);
      }
      outcome = settlement.kind === "settled" ? settlement.value : { kind: "unknown" };
    } else {
      outcome = await promise;
    }
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) {
      return deliveryStoreFailure("ownership_lost", input.delivery.id);
    }
    outcome = { kind: "unknown" };
  }
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  if (input.abort.aborted && outcome.kind === "definitive_rejection") {
    outcome = { kind: "unknown" };
  }
  const currentAfterEffect = await runUntilAborted(durableOperationSignal, () =>
    ports.ownership.isCurrent(input.fencingToken),
  );
  if (
    currentAfterEffect.kind === "aborted" ||
    (currentAfterEffect.kind === "settled" && currentAfterEffect.value !== true)
  ) {
    return deliveryStoreFailure("ownership_lost", input.delivery.id);
  }
  if (currentAfterEffect.kind === "rejected") {
    return deliveryStoreFailure(
      currentAfterEffect.cause instanceof OwnershipLostFault
        ? "ownership_lost"
        : "storage_unavailable",
      input.delivery.id,
    );
  }
  return recordOutcome(
    ports,
    input.workspaceKey,
    input.fencingToken,
    input.delivery.id,
    outcome,
    durableOperationSignal,
    input.interruptionMeansOwnershipLoss === true ? input.deadlineMs : undefined,
  );
}
