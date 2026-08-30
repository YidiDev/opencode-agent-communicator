import { OwnershipLostFault } from "../domain/ownership";
import type { PendingRequestMetadata, PendingRequestPayload } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { runUntilAborted } from "./abortable-operation";
import { readAuthoritativeRequest as readAuthoritative } from "./blocking-request-source-projection";
import type { BlockingSessionRequestSuccess } from "./blocking-request-wait-contracts";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
import { observeNativePromiseRejection } from "./native-promise-observation";
import type { CommittedRequestTerminalEvent } from "./request-notification-port";
import type { RequestRuntimeRegistration } from "./request-runtime";
import { snapshotDataRecord } from "./strict-port-boundaries";

export type { BlockingSessionRequestSuccess } from "./blocking-request-wait-contracts";

export class RequestRuntimeShutdownFault extends Error {
  override readonly name = "RequestRuntimeShutdownFault";
}

const _storageFailure = (): DomainResult<never> =>
  domainFailure("storage_unavailable", "Request storage is unavailable.", true);
const cleanupTimeoutMs = 1_000;

const cleanupStorageFailure = (requestId: string): DomainResult<never> =>
  domainFailure("storage_unavailable", "Authoritative request state is unavailable.", true, {
    request_id: requestId,
  });

async function cancelAfterAbort(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  request: PendingRequestMetadata,
  approvedPayload: PendingRequestPayload,
): Promise<DomainResult<BlockingSessionRequestSuccess>> {
  let ownershipLost = false;
  try {
    const cancellation = await settleCleanupPhase(
      ports,
      "request_cancellation_settlement_deadline",
      () =>
        ports.requests.cancelPending({
          fencingToken: context.fencingToken,
          workspaceKey: context.workspaceKey,
          requestId: request.id,
          callerSessionId: context.sourceSessionId,
        }),
    );
    if (cancellation.kind === "rejected") {
      ownershipLost = cancellation.cause instanceof OwnershipLostFault;
    } else if (cancellation.kind === "settled") {
      const result = snapshotDataRecord(cancellation.value, 4);
      ownershipLost = result?.ok === false && result.code === "ownership_lost";
    }

    // cancelPending is only a CAS attempt. Its terminal_state result is not the winner; the fenced
    // source projection below is authoritative for cancellation, answers, reaches, and all faults.
    // It deliberately receives a fresh bound: a commit whose Promise never settles must not poison
    // reconciliation with the already-aborted cancellation-settlement signal.
    const reconciliation = await settleCleanupPhase(
      ports,
      "request_cancellation_reconciliation_deadline",
      (signal) => readAuthoritative(ports, context, request, approvedPayload, signal),
    );
    if (reconciliation.kind !== "settled") {
      return ownershipLost
        ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false, {
            request_id: request.id,
          })
        : cleanupStorageFailure(request.id);
    }
    const authoritative = reconciliation.value;
    if (!authoritative.ok) {
      if (authoritative.error.code !== "storage_unavailable") return authoritative;
      return ownershipLost
        ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false, {
            request_id: request.id,
          })
        : cleanupStorageFailure(request.id);
    }
    return authoritative.value === "pending"
      ? cleanupStorageFailure(request.id)
      : { ok: true, value: authoritative.value };
  } catch (cause: unknown) {
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false, {
          request_id: request.id,
        })
      : cleanupStorageFailure(request.id);
  } finally {
    wakeSchedulerSafely(ports);
    ports.runtime.wakeRequest(request.id);
  }
}

async function settleCleanupPhase<Value>(
  ports: SessionBlockingRequestPorts,
  deadlineReason: string,
  operation: (signal: AbortSignal) => Promise<Value>,
) {
  const controller = new AbortController();
  let timer: { cancel(): void } | undefined;
  const stop = (): void => controller.abort("request_cancellation_lifecycle_stopped");
  try {
    ports.runtime.effectSignal.addEventListener("abort", stop, { once: true });
    if (ports.runtime.effectSignal.aborted) stop();
    timer = ports.deadlineTimer.arm(cleanupTimeoutMs, () => controller.abort(deadlineReason));
    return await runUntilAborted(controller.signal, () => operation(controller.signal));
  } catch (cause: unknown) {
    return { kind: "rejected" as const, cause };
  } finally {
    ports.runtime.effectSignal.removeEventListener("abort", stop);
    timer?.cancel();
  }
}

async function readForegroundAuthoritative(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  request: PendingRequestMetadata,
  approvedPayload: PendingRequestPayload,
  localWake: AbortSignal,
): Promise<
  | {
      readonly kind: "settled";
      readonly value: DomainResult<"pending" | BlockingSessionRequestSuccess>;
    }
  | { readonly kind: "aborted" }
> {
  const controller = new AbortController();
  const interrupt = (signal: AbortSignal): void => controller.abort(signal.reason);
  const callerInterrupt = (): void => interrupt(context.abort);
  const localInterrupt = (): void => interrupt(localWake);
  try {
    context.abort.addEventListener("abort", callerInterrupt, { once: true });
    localWake.addEventListener("abort", localInterrupt, { once: true });
    if (context.abort.aborted) callerInterrupt();
    if (localWake.aborted) localInterrupt();
    const settlement = await runUntilAborted(controller.signal, () =>
      readAuthoritative(ports, context, request, approvedPayload, controller.signal),
    );
    return settlement.kind === "settled"
      ? { kind: "settled", value: settlement.value }
      : settlement.kind === "aborted"
        ? { kind: "aborted" }
        : { kind: "settled", value: _storageFailure() };
  } finally {
    context.abort.removeEventListener("abort", callerInterrupt);
    localWake.removeEventListener("abort", localInterrupt);
  }
}

async function readFinalAuthoritative(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  request: PendingRequestMetadata,
  approvedPayload: PendingRequestPayload,
): Promise<DomainResult<"pending" | BlockingSessionRequestSuccess>> {
  const controller = new AbortController();
  let timer: { cancel(): void } | undefined;
  try {
    timer = ports.deadlineTimer.arm(cleanupTimeoutMs, () =>
      controller.abort("request_final_reconciliation_deadline"),
    );
    const settlement = await runUntilAborted(controller.signal, () =>
      readAuthoritative(ports, context, request, approvedPayload, controller.signal),
    );
    return settlement.kind === "settled" ? settlement.value : cleanupStorageFailure(request.id);
  } catch {
    return cleanupStorageFailure(request.id);
  } finally {
    timer?.cancel();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: durable wait, cancellation, deadline, lifecycle, and reattachment races are intentionally linear and auditable.
export async function blockUntilRequestTerminal(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  request: PendingRequestMetadata,
  provisional: RequestRuntimeRegistration,
  approvedPayload: PendingRequestPayload,
  admissionController: AbortController,
): Promise<DomainResult<BlockingSessionRequestSuccess>> {
  const notified = new Set<string>();
  const workflowPorts: SessionBlockingRequestPorts = {
    ...ports,
    notifications: {
      notifyTerminal(event: CommittedRequestTerminalEvent): undefined {
        const key = `${event.requestId}:${event.resolutionState}:${event.resolvedAtMs}`;
        if (notified.has(key)) return undefined;
        notified.add(key);
        return ports.notifications.notifyTerminal(event);
      },
    },
  };
  let registration = provisional;
  let queryController = new AbortController();
  let cancelTask: Promise<DomainResult<BlockingSessionRequestSuccess>> | undefined;
  const onAbort = (): void => {
    queryController.abort("explicit_request_cancellation");
    cancelTask ??= cancelAfterAbort(workflowPorts, context, request, approvedPayload);
    observeNativePromiseRejection(cancelTask);
  };
  context.abort.addEventListener("abort", onAbort, { once: true });
  if (context.abort.aborted) onAbort();
  const invocationFirst =
    context.deadlineMs !== undefined && context.deadlineMs < request.deadlineAtMs;
  const wakeAtMs = invocationFirst ? (context.deadlineMs as number) : request.deadlineAtMs;
  let deadlineTimer: { cancel(): void };
  try {
    const nowMs = ports.clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid local clock");
    deadlineTimer = ports.deadlineTimer.arm(Math.max(0, wakeAtMs - nowMs), () => {
      admissionController.abort(invocationFirst ? "invocation_deadline" : "request_deadline");
      if (invocationFirst) {
        onAbort();
      }
      queryController.abort("authoritative_read_deadline");
      wakeSchedulerSafely(ports);
      ports.runtime.wakeRequest(request.id);
    });
  } catch {
    context.abort.removeEventListener("abort", onAbort);
    admissionController.abort("local_deadline_unavailable");
    registration.detach();
    return domainFailure(
      "storage_unavailable",
      "Local request reconciliation is unavailable.",
      true,
      {
        request_id: request.id,
      },
    );
  }
  try {
    while (true) {
      if (cancelTask) return await cancelTask;
      queryController = new AbortController();
      const durableTask = readForegroundAuthoritative(
        workflowPorts,
        context,
        request,
        approvedPayload,
        queryController.signal,
      );
      let first = await Promise.race([
        durableTask.then((durable) => ({ type: "durable" as const, durable })),
        registration.outcome.then((outcome) => ({ type: "runtime" as const, outcome })),
      ]);
      if (first.type === "runtime") {
        queryController.abort("runtime_reconciliation_wake");
      } else {
        if (first.durable.kind === "aborted") {
          if (cancelTask) return await cancelTask;
          continue;
        }
        const durable = first.durable.value;
        if (!durable.ok) {
          if (cancelTask) return await cancelTask;
          return durable;
        }
        if (durable.value !== "pending") return { ok: true, value: durable.value };
        first = { type: "runtime", outcome: await registration.outcome };
      }
      if (first.outcome.outcome === "shutdown" || first.outcome.outcome === "ownership_lost") {
        const final = await readFinalAuthoritative(
          workflowPorts,
          context,
          request,
          approvedPayload,
        );
        if (final.ok && final.value !== "pending") return { ok: true, value: final.value };
        if (!final.ok && final.error.code !== "storage_unavailable") return final;
        if (first.outcome.outcome === "shutdown") throw new RequestRuntimeShutdownFault();
        return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
      }
      // Runtime events are wake hints only. The fenced participant projection decides the winner.
      registration.detach();
      try {
        registration = ports.runtime.attach({
          requestId: request.id,
          expectedKind: request.kind,
          sourceSessionId: request.sourceSessionId,
          workspaceKey: request.workspaceKey,
        });
      } catch {
        const afterCapacityRace = await readForegroundAuthoritative(
          workflowPorts,
          context,
          request,
          approvedPayload,
          new AbortController().signal,
        );
        if (
          afterCapacityRace.kind !== "settled" ||
          !afterCapacityRace.value.ok ||
          afterCapacityRace.value.value === "pending"
        ) {
          return afterCapacityRace.kind === "settled" && !afterCapacityRace.value.ok
            ? afterCapacityRace.value
            : domainFailure(
                "storage_unavailable",
                "Request waiter capacity is unavailable.",
                true,
                { request_id: request.id },
              );
        }
        return { ok: true, value: afterCapacityRace.value.value };
      }
    }
  } finally {
    context.abort.removeEventListener("abort", onAbort);
    deadlineTimer.cancel();
    admissionController.abort("foreground_terminal");
    registration.detach();
  }
}

function wakeSchedulerSafely(ports: SessionBlockingRequestPorts): void {
  try {
    ports.scheduler.wake();
  } catch {
    // The timer is only a hint; the immediate local runtime wake still forces reconciliation.
  }
}
