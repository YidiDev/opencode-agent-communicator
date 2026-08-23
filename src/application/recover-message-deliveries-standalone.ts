import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { deliveryStoreFailure } from "./admit-message-delivery";
import { inspectStartupBarrier } from "./message-recovery-boundaries";
import {
  classifyStaleMessageDeliveries,
  type MessageRecoveryPorts,
  type MessageRecoverySummary,
  recoverPreparedMessageDeliveries,
} from "./recover-message-delivery-phases";
import { operationControlStopped } from "./safe-clock";
import { createLinkedEffectControl, type StartupDeadlineTimerPort } from "./startup-effect-control";

function standalonePhaseFailure(result: DomainResult<never>): DomainResult<never> {
  return !result.ok && result.error.code === "storage_unavailable"
    ? domainFailure("storage_unavailable", "Delivery recovery storage is unavailable.", true)
    : result;
}

export async function recoverMessageDeliveries(
  ports: MessageRecoveryPorts,
  input: {
    readonly workspaceKey: WorkspaceKey;
    readonly abort: AbortSignal;
    readonly deadlineMs?: number;
    readonly limit: number;
    readonly timers?: StartupDeadlineTimerPort;
  },
): Promise<DomainResult<MessageRecoverySummary>> {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.deadlineMs !== undefined &&
      (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 0))
  ) {
    return domainFailure(
      "invalid_arguments",
      "Recovery limit must be an integer from 1 to 100.",
      false,
    );
  }
  const control = createLinkedEffectControl({
    signals: [input.abort],
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    clock: ports.clock,
    ...(input.timers ? { timers: input.timers } : {}),
  });
  if (!control) {
    return domainFailure("storage_unavailable", "Delivery recovery storage is unavailable.", true);
  }
  try {
    const acquired = await runUntilAborted(control.signal, () => ports.ownership.acquire());
    if (acquired.kind === "aborted") return deliveryStoreFailure("ownership_lost");
    if (acquired.kind === "rejected") throw acquired.cause;
    const fencingToken = acquired.value;
    const established = await runUntilAborted(control.signal, () =>
      ports.startupBarrier.establish(fencingToken, {
        abort: control.signal,
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      }),
    );
    if (established.kind === "aborted") return deliveryStoreFailure("ownership_lost");
    if (established.kind === "rejected") throw established.cause;
    const startupBarrier = inspectStartupBarrier(established.value, fencingToken);
    if (!startupBarrier) return deliveryStoreFailure("state_conflict");
    const phaseInput = { ...input, abort: control.signal, fencingToken, startupBarrier };
    const ambiguous = await classifyStaleMessageDeliveries(ports, phaseInput);
    if (!ambiguous.ok) return standalonePhaseFailure(ambiguous);
    if (operationControlStopped(ports.clock, control.signal, input.deadlineMs)) {
      return deliveryStoreFailure("ownership_lost");
    }
    const prepared = await recoverPreparedMessageDeliveries(ports, phaseInput);
    if (!prepared.ok) return standalonePhaseFailure(prepared);
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
  } finally {
    try {
      control.dispose();
    } catch {
      // The operation is already settled; cleanup failure cannot expose adapter details.
    }
  }
}
