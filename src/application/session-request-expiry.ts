import type { RequestId } from "../domain/generated-ids";
import { OwnershipLostFault, validateFencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateWorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { inspectPendingDeadlineSchedule } from "./request-deadline-boundaries";
import { inspectExpiredRequestBatch } from "./request-expiry-boundary";
import type {
  RequestStoreFailureCode,
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "./request-ports";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { operationControlStopped } from "./safe-clock";
import {
  requestStartupExpiryBatchLimit,
  requestStartupPendingRecoveryMaximumRecords,
} from "./session-request-recovery-limits";

function failure(code: RequestStoreFailureCode): DomainResult<never> {
  return domainFailure(
    code,
    code === "ownership_lost"
      ? "Coordinator ownership was lost."
      : "Request expiry storage is unavailable.",
    code === "storage_unavailable" || code === "rate_limited",
  );
}

function valid(input: SessionRequestRecoveryPhaseInput): boolean {
  return (
    validateWorkspaceKey(input.workspaceKey).ok &&
    validateFencingToken(input.fencingToken).ok &&
    typeof input.abort === "object" &&
    input.abort !== null &&
    typeof input.abort.aborted === "boolean" &&
    typeof input.effectSignal === "object" &&
    input.effectSignal !== null &&
    typeof input.effectSignal.aborted === "boolean" &&
    Number.isSafeInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= 100 &&
    (input.deadlineMs === undefined ||
      (Number.isSafeInteger(input.deadlineMs) && input.deadlineMs >= 0))
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict batch, abort, schedule, and exact-ceiling certification share one fail-closed drain boundary.
export async function expireDueSessionRequests(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
): Promise<DomainResult<number>> {
  if (!valid(input)) {
    return domainFailure("invalid_arguments", "Request recovery phase input is invalid.", false);
  }
  const seen = new Set<RequestId>();
  let expired = 0;
  while (true) {
    if (operationControlStopped(ports.clock, input.abort, input.deadlineMs)) {
      return failure("ownership_lost");
    }
    const requested = Math.min(
      requestStartupExpiryBatchLimit,
      requestStartupPendingRecoveryMaximumRecords - seen.size,
    );
    const settlement = await runUntilAborted(input.effectSignal, () =>
      ports.requests.expireDueRequests({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        limit: requested,
      }),
    );
    if (settlement.kind === "aborted") return failure("ownership_lost");
    if (settlement.kind === "rejected") {
      return failure(
        settlement.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      );
    }
    const batch = inspectExpiredRequestBatch({
      value: settlement.value,
      workspaceKey: input.workspaceKey,
      seen,
      batchLimit: requestStartupExpiryBatchLimit,
      hardLimit: requestStartupPendingRecoveryMaximumRecords,
    });
    if (!batch.ok) return batch;
    for (const request of batch.value) {
      expired += 1;
      notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(request));
    }
    if (batch.value.length < requested) {
      return { ok: true, value: expired };
    }
    if (expired === requestStartupPendingRecoveryMaximumRecords) {
      if (operationControlStopped(ports.clock, input.abort, input.deadlineMs)) {
        return failure("ownership_lost");
      }
      const scheduleSettlement = await runUntilAborted(input.effectSignal, () =>
        ports.requests.readNextPendingDeadline({
          fencingToken: input.fencingToken,
          workspaceKey: input.workspaceKey,
        }),
      );
      if (scheduleSettlement.kind === "aborted") return failure("ownership_lost");
      if (scheduleSettlement.kind === "rejected") {
        return failure(
          scheduleSettlement.cause instanceof OwnershipLostFault
            ? "ownership_lost"
            : "storage_unavailable",
        );
      }
      const schedule = inspectPendingDeadlineSchedule(scheduleSettlement.value);
      if (
        !schedule ||
        (schedule.nextDeadlineAtMs !== undefined &&
          schedule.nextDeadlineAtMs <= schedule.storeObservedAtMs)
      ) {
        return failure("storage_unavailable");
      }
      return { ok: true, value: expired };
    }
  }
}
