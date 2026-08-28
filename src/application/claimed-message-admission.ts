import type { DeliveryMetadata } from "../domain/deliveries";
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
import { snapshotDataRecord } from "./strict-port-boundaries";

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
  write: Extract<DeliveryStoreResult, { readonly ok: true }>,
): DomainResult<DeliveryMetadata> {
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

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function inspectNativeAdmission(value: unknown): NativeQueueAdmission {
  const record = snapshotDataRecord(value, 4);
  if (!record) return { kind: "unknown" };
  if (
    exactKeys(record, ["kind"]) &&
    (record.kind === "unknown" || record.kind === "definitive_rejection")
  ) {
    return { kind: record.kind };
  }
  if (
    exactKeys(record, ["kind", "admittedSeq", "observedAtMs"]) &&
    record.kind === "admitted" &&
    Number.isSafeInteger(record.admittedSeq) &&
    (record.admittedSeq as number) >= 0 &&
    Number.isFinite(record.observedAtMs) &&
    (record.observedAtMs as number) >= 0
  ) {
    return {
      kind: "admitted",
      admittedSeq: record.admittedSeq as number,
      observedAtMs: record.observedAtMs as number,
    };
  }
  if (
    exactKeys(record, ["kind", "admittedSeq", "promotedSeq", "observedAtMs"]) &&
    record.kind === "promoted" &&
    Number.isSafeInteger(record.admittedSeq) &&
    (record.admittedSeq as number) >= 0 &&
    Number.isSafeInteger(record.promotedSeq) &&
    (record.promotedSeq as number) > (record.admittedSeq as number) &&
    Number.isFinite(record.observedAtMs) &&
    (record.observedAtMs as number) >= 0
  ) {
    return {
      kind: "promoted",
      admittedSeq: record.admittedSeq as number,
      promotedSeq: record.promotedSeq as number,
      observedAtMs: record.observedAtMs as number,
    };
  }
  return { kind: "unknown" };
}

export function claimedAdmissionUnknown(deliveryId: DeliveryId): DomainResult<never> {
  return domainFailure(
    "admission_unknown",
    "Native queue admission could not be determined before the invocation deadline.",
    false,
    { delivery_id: deliveryId },
  );
}

export function isDurablyRecordedOutcome(result: DomainResult<DeliveryMetadata>): boolean {
  return (
    result.ok ||
    result.error.code === "admission_failed" ||
    result.error.code === "admission_unknown"
  );
}

export async function recordOutcome(
  ports: MessageAdmissionPorts,
  workspaceKey: WorkspaceKey,
  fencingToken: FencingToken,
  deliveryId: DeliveryMetadata["id"],
  outcome: NativeQueueAdmission,
  abort: AbortSignal,
  deadlineMs: number | undefined,
): Promise<DomainResult<DeliveryMetadata>> {
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

export function deadlineLinkedSignal(
  abort: AbortSignal,
  deadlineMs: number,
): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort("message invocation interrupted");
  if (abort.aborted || Date.now() >= deadlineMs) onAbort();
  else abort.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, Math.max(0, deadlineMs - Date.now()));
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      abort.removeEventListener("abort", onAbort);
    },
  };
}
