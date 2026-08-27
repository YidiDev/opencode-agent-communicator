import type { DeliveryMetadata } from "../domain/deliveries";
import type { DeliveryId } from "../domain/generated-ids";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { boundedExternalCall } from "./bounded-external-call";
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

function inspectNativeAdmission(value: unknown): NativeQueueAdmission {
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

function claimedAdmissionUnknown(deliveryId: DeliveryId): DomainResult<never> {
  return domainFailure(
    "admission_unknown",
    "Native queue admission could not be determined before the invocation deadline.",
    false,
    { delivery_id: deliveryId },
  );
}

function isDurablyRecordedOutcome(result: DomainResult<DeliveryMetadata>): boolean {
  return (
    result.ok ||
    result.error.code === "admission_failed" ||
    result.error.code === "admission_unknown"
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

function deadlineLinkedSignal(
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
    const recording = recordOutcome(
      ports,
      input.workspaceKey,
      input.fencingToken,
      input.delivery.id,
      { kind: "unknown" },
      new AbortController().signal,
      undefined,
    );
    recording.catch(() => undefined);
  };
  const current = await bounded(() => ports.ownership.isCurrent(input.fencingToken));
  if (current.kind === "aborted" && !recovery) {
    recordUnknownWithoutWaiting();
    return claimedAdmissionUnknown(input.delivery.id);
  }
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
  if (recovery) {
    try {
      const promise = ports.nativeQueue.queueMessage({
        targetSessionId: input.delivery.targetSessionId,
        nativeMessageId: input.delivery.nativeMessageId,
        envelope: input.envelope,
        abort: input.abort,
      });
      const settlement = await runUntilAborted(input.abort, () => promise);
      if (settlement.kind === "aborted") {
        return deliveryStoreFailure("ownership_lost", input.delivery.id);
      }
      if (settlement.kind === "rejected" && settlement.cause instanceof OwnershipLostFault) {
        return deliveryStoreFailure("ownership_lost", input.delivery.id);
      }
      outcome = settlement.kind === "settled" ? settlement.value : { kind: "unknown" };
    } catch (cause: unknown) {
      if (cause instanceof OwnershipLostFault) {
        return deliveryStoreFailure("ownership_lost", input.delivery.id);
      }
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
    if (isDurablyRecordedOutcome(recorded.value)) {
      return recorded.value;
    }
    recordUnknownWithoutWaiting();
    return claimedAdmissionUnknown(input.delivery.id);
  }
  const recorded = await boundedExternalCall(record, input.abort, input.deadlineMs);
  if (recorded.kind === "value") {
    if (isDurablyRecordedOutcome(recorded.value)) {
      return recorded.value;
    }
    recordUnknownWithoutWaiting();
    return claimedAdmissionUnknown(input.delivery.id);
  }
  if (recorded.kind === "rejected") recordUnknownWithoutWaiting();
  return claimedAdmissionUnknown(input.delivery.id);
}
