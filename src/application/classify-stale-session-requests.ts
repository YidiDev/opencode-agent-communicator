import type { RequestId } from "../domain/generated-ids";
import { OwnershipLostFault } from "../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../domain/request-identity";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { isCoherentStartOperation } from "../domain/session-start";
import { runUntilAborted } from "./abortable-operation";
import type {
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { requestStartupSubmittingRecoveryMaximumRecords } from "./session-request-recovery-limits";
import {
  rejectedRequestRecoveryFailure,
  requestRecoveryFailure,
  sessionRequestRecoveryControlStopped,
  snapshotRecoveryRequest,
  validRequestStoreFailure,
  validSessionRequestRecoveryPhaseInput,
} from "./session-request-recovery-support";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear stale-request classifier keeps ownership, linked-start correlation, and the terminal commit auditable.
async function classifyOneStaleRequest(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
  request: RequestMetadata,
): Promise<DomainResult<undefined>> {
  if (sessionRequestRecoveryControlStopped(ports, input)) {
    return requestRecoveryFailure("ownership_lost");
  }
  const current = await runUntilAborted(input.effectSignal, () =>
    ports.ownership.isCurrent(input.fencingToken),
  );
  if (current.kind === "aborted") return requestRecoveryFailure("ownership_lost");
  if (current.kind === "rejected") {
    return rejectedRequestRecoveryFailure(
      current.cause,
      "Request recovery storage is unavailable.",
    );
  }
  if (current.value !== true) return requestRecoveryFailure("ownership_lost");
  const base = {
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    requestId: request.id,
  };
  let completionInput:
    | (typeof base & { readonly outcome: "delivery_unknown" | "delivery_failed" })
    | (typeof base & {
        readonly outcome: "admitted";
        readonly nativeMessageId: RequestMetadata["nativeMessageId"];
        readonly admittedSeq: number;
        readonly evidenceObservedAtMs: number;
      }) = { ...base, outcome: "delivery_unknown" };
  if (request.deliveryMode === "initial") {
    const readLinked = ports.requestStarts?.readSessionRequestStartByOperation;
    const linkedStartOperationId = request.linkedStartOperationId;
    if (!readLinked || !linkedStartOperationId) {
      return requestRecoveryFailure("storage_unavailable");
    }
    const linkedSettlement = await runUntilAborted(input.effectSignal, () =>
      readLinked({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        operationId: linkedStartOperationId,
      }),
    );
    if (linkedSettlement.kind !== "settled" || !linkedSettlement.value) {
      return requestRecoveryFailure(
        linkedSettlement.kind === "aborted" ? "ownership_lost" : "storage_unavailable",
      );
    }
    const operation = linkedSettlement.value.operation;
    if (
      !isCoherentStartOperation(operation) ||
      operation.id !== linkedStartOperationId ||
      operation.workspaceKey !== request.workspaceKey ||
      operation.sourceSessionId !== request.sourceSessionId ||
      operation.sessionId !== request.targetSessionId ||
      operation.nativeMessageId !== request.nativeMessageId
    ) {
      return requestRecoveryFailure("storage_unavailable");
    }
    if (operation.admissionState === "admitted") {
      completionInput = {
        ...base,
        outcome: "admitted",
        nativeMessageId: request.nativeMessageId,
        admittedSeq: 0,
        evidenceObservedAtMs: ports.clock.nowMs(),
      };
    } else if (operation.admissionState === "failed" || operation.creationState === "failed") {
      completionInput = { ...base, outcome: "delivery_failed" };
    } else if (operation.admissionState !== "admission_unknown") {
      return requestRecoveryFailure("storage_unavailable");
    }
  }
  let rawCompletion: unknown;
  try {
    const settlement = await runUntilAborted(input.effectSignal, () =>
      ports.requests.completeDelivery({
        ...completionInput,
      }),
    );
    if (settlement.kind === "aborted") return requestRecoveryFailure("ownership_lost");
    if (settlement.kind === "rejected") {
      return rejectedRequestRecoveryFailure(
        settlement.cause,
        "Request recovery storage is unavailable.",
      );
    }
    rawCompletion = settlement.value;
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) return requestRecoveryFailure("ownership_lost");
    return domainFailure("storage_unavailable", "Request recovery storage is unavailable.", true);
  }
  const completion = snapshotDataRecord(rawCompletion, 2);
  if (!completion) return requestRecoveryFailure("storage_unavailable");
  if (completion.ok === false) {
    return validRequestStoreFailure(completion.code)
      ? requestRecoveryFailure(completion.code)
      : requestRecoveryFailure("storage_unavailable");
  }
  const committed = inspectRequestMetadata(completion.request);
  if (
    completion.ok !== true ||
    !committed ||
    !isCoherentRequestMetadata(committed) ||
    !hasRequestIdentity(snapshotRequestIdentity(request), committed) ||
    committed.deliveryState !== completionInput.outcome
  ) {
    return requestRecoveryFailure("storage_unavailable");
  }
  if (committed.resolutionState !== "pending") {
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(committed));
  }
  return { ok: true, value: undefined };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the bounded stale traversal keeps fencing, exact snapshots, mutation, and counting atomic in review.
export async function classifyStaleSessionRequests(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
): Promise<DomainResult<number>> {
  if (!validSessionRequestRecoveryPhaseInput(input)) {
    return domainFailure("invalid_arguments", "Request recovery phase input is invalid.", false);
  }
  if (input.startupBarrier.fencingToken !== input.fencingToken) {
    return requestRecoveryFailure("ownership_lost");
  }
  const seen = new Set<RequestId>();
  let changed = 0;
  while (true) {
    if (sessionRequestRecoveryControlStopped(ports, input)) {
      return requestRecoveryFailure("ownership_lost");
    }
    if (seen.size === requestStartupSubmittingRecoveryMaximumRecords) {
      const residual = await runUntilAborted(input.effectSignal, () =>
        ports.requests.listRecoverableRequests({
          fencingToken: input.fencingToken,
          workspaceKey: input.workspaceKey,
          state: "submitting",
          limit: 1,
          excludeClaimedByToken: input.fencingToken,
          startupBarrier: input.startupBarrier,
        }),
      );
      if (residual.kind === "aborted") return requestRecoveryFailure("ownership_lost");
      if (residual.kind === "rejected") {
        return rejectedRequestRecoveryFailure(
          residual.cause,
          "Request recovery storage is unavailable.",
        );
      }
      const remaining = snapshotDenseArray(residual.value, 1);
      return remaining?.length === 0
        ? { ok: true, value: changed }
        : requestRecoveryFailure("storage_unavailable");
    }
    let records: unknown;
    try {
      const settlement = await runUntilAborted(input.effectSignal, () =>
        ports.requests.listRecoverableRequests({
          fencingToken: input.fencingToken,
          workspaceKey: input.workspaceKey,
          state: "submitting",
          limit: Math.min(input.limit, requestStartupSubmittingRecoveryMaximumRecords - seen.size),
          excludeClaimedByToken: input.fencingToken,
          startupBarrier: input.startupBarrier,
        }),
      );
      if (settlement.kind === "aborted") return requestRecoveryFailure("ownership_lost");
      if (settlement.kind === "rejected") {
        return rejectedRequestRecoveryFailure(
          settlement.cause,
          "Request recovery storage is unavailable.",
        );
      }
      records = settlement.value;
    } catch (cause: unknown) {
      if (cause instanceof OwnershipLostFault) return requestRecoveryFailure("ownership_lost");
      return domainFailure("storage_unavailable", "Request recovery storage is unavailable.", true);
    }
    const batch = snapshotDenseArray(
      records,
      Math.min(input.limit, requestStartupSubmittingRecoveryMaximumRecords - seen.size),
    );
    if (!batch) return requestRecoveryFailure("storage_unavailable");
    if (batch.length === 0) return { ok: true, value: changed };
    for (const rawRequest of batch) {
      const request = snapshotRecoveryRequest(rawRequest, input.workspaceKey, "submitting");
      if (
        !request ||
        seen.has(request.id) ||
        seen.size >= requestStartupSubmittingRecoveryMaximumRecords
      ) {
        return requestRecoveryFailure("storage_unavailable");
      }
      seen.add(request.id);
      const classified = await classifyOneStaleRequest(ports, input, request);
      if (!classified.ok) return classified;
      changed += 1;
    }
  }
}
