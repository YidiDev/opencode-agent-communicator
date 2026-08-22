import { type DeliveryMetadata, isCoherentDeliveryMetadata } from "../domain/deliveries";
import type { DeliveryId } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import type {
  ClockPort,
  DeliveryPersistencePort,
  DeliveryStoreFailureCode,
  DeliveryStoreResult,
  NativeQueueAdmission,
  NativeQueueAdmissionPort,
  OwnershipPort,
} from "./delivery-ports";

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
): Promise<DomainResult<DeliveryMetadata>> {
  if (!isCoherent(outcome)) outcome = { kind: "unknown" };
  if (outcome.kind === "promoted") {
    const promoted = await ports.deliveries.completeSubmission({
      fencingToken,
      workspaceKey,
      deliveryId,
      state: "promoted",
      nowMs: ports.clock.nowMs(),
      admittedSeq: outcome.admittedSeq,
      promotedSeq: outcome.promotedSeq,
      evidenceObservedAtMs: outcome.observedAtMs,
    });
    return promoted.ok
      ? admissionResult(outcome, promoted)
      : deliveryStoreFailure(promoted.code, deliveryId);
  }
  const result =
    outcome.kind === "admitted"
      ? await ports.deliveries.completeSubmission({
          workspaceKey,
          fencingToken,
          deliveryId,
          state: "admitted",
          nowMs: ports.clock.nowMs(),
          admittedSeq: outcome.admittedSeq,
          evidenceObservedAtMs: outcome.observedAtMs,
        })
      : await ports.deliveries.completeSubmission({
          workspaceKey,
          fencingToken,
          deliveryId,
          state: outcome.kind === "definitive_rejection" ? "failed" : "admission_unknown",
          nowMs: ports.clock.nowMs(),
        });
  return result.ok
    ? admissionResult(outcome, result)
    : deliveryStoreFailure(result.code, deliveryId);
}

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
  const stopped = (): boolean =>
    input.interruptionMeansOwnershipLoss === true &&
    (input.abort.aborted ||
      (input.deadlineMs !== undefined && ports.clock.nowMs() >= input.deadlineMs));
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  if (!(await ports.ownership.isCurrent(input.fencingToken))) {
    return deliveryStoreFailure("ownership_lost", input.delivery.id);
  }
  // No awaited work is allowed between this final control check and the native effect.
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  let outcome: NativeQueueAdmission;
  try {
    outcome = await ports.nativeQueue.queueMessage({
      targetSessionId: input.delivery.targetSessionId,
      nativeMessageId: input.delivery.nativeMessageId,
      envelope: input.envelope,
      abort: input.abort,
    });
  } catch (_cause: unknown) {
    outcome = { kind: "unknown" };
  }
  if (stopped()) return deliveryStoreFailure("ownership_lost", input.delivery.id);
  if (input.abort.aborted && outcome.kind === "definitive_rejection") {
    outcome = { kind: "unknown" };
  }
  if (!(await ports.ownership.isCurrent(input.fencingToken))) {
    return deliveryStoreFailure("ownership_lost", input.delivery.id);
  }
  return recordOutcome(ports, input.workspaceKey, input.fencingToken, input.delivery.id, outcome);
}
