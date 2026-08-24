import { OwnershipLostFault } from "../domain/ownership";
import {
  validateAskResponseAgainstPendingPayload,
  type validateRetainedRequestResult,
  validateWaitRequestResult,
} from "../domain/request-content";
import type { PendingRequestMetadata, PendingRequestPayload } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { runUntilAborted } from "./abortable-operation";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
import { observeNativePromiseRejection } from "./native-promise-observation";
import { inspectParticipantRequestMetadata } from "./participant-request-boundaries";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import type { RequestRuntimeRegistration } from "./request-runtime";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export type BlockingSessionRequestSuccess =
  | {
      readonly request_id: string;
      readonly state: "answered";
      readonly answers: readonly (readonly string[])[];
    }
  | { readonly request_id: string; readonly state: "reached"; readonly evidence?: string };

export class RequestRuntimeShutdownFault extends Error {
  override readonly name = "RequestRuntimeShutdownFault";
}

const storageFailure = (): DomainResult<never> =>
  domainFailure("storage_unavailable", "Request storage is unavailable.", true);
const cleanupTimeoutMs = 1_000;

const cleanupStorageFailure = (requestId: string): DomainResult<never> =>
  domainFailure("storage_unavailable", "Authoritative request state is unavailable.", true, {
    request_id: requestId,
  });

function notifyTerminalizations(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  expectedRequestId: string,
  raw: unknown,
): boolean {
  const found = snapshotDataRecord(raw, 5);
  if (!found) return false;
  if (!Object.hasOwn(found, "terminalized")) return false;
  const items = snapshotDenseArray(found.terminalized, 2);
  if (!items) return false;
  for (const item of items) {
    const request = inspectRequestMetadata(item);
    if (
      !request ||
      request.resolutionState === "pending" ||
      request.workspaceKey !== context.workspaceKey ||
      request.id !== expectedRequestId ||
      (request.sourceSessionId !== context.sourceSessionId &&
        request.targetSessionId !== context.sourceSessionId)
    )
      return false;
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(request));
  }
  return true;
}

function snapshotResult(value: unknown): unknown {
  const result = snapshotDataRecord(value, 2);
  if (!result || typeof result.kind !== "string") return undefined;
  if (result.kind === "wait") {
    return Object.hasOwn(result, "evidence")
      ? { kind: "wait", evidence: result.evidence }
      : { kind: "wait" };
  }
  if (result.kind !== "ask") return undefined;
  const outer = snapshotDenseArray(result.answers, 10);
  if (!outer) return undefined;
  const answers: unknown[][] = [];
  for (const item of outer) {
    const answer = snapshotDenseArray(item, 20);
    if (!answer) return undefined;
    answers.push(answer);
  }
  return { kind: "ask", answers };
}

function terminalFailure(state: unknown): DomainResult<never> {
  const messages = {
    cancelled: ["request_cancelled", "Request was cancelled."],
    deadline_expired: ["deadline_expired", "Request deadline expired."],
    delivery_failed: ["delivery_failed", "Request delivery failed."],
    target_stopped: ["target_stopped", "Request target was stopped."],
    source_stopped: ["source_stopped", "Request source was stopped."],
    target_deleted: ["target_deleted", "Request target was deleted."],
    source_deleted: ["source_deleted", "Request source was deleted."],
    result_expired: ["result_expired", "The retained request result is no longer available."],
  } as const;
  const mapped = messages[state as keyof typeof messages];
  return mapped ? domainFailure(mapped[0], mapped[1], false) : storageFailure();
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authoritative source projections deliberately keep every terminal state and result correlation in one strict boundary.
function sourceProjection(
  raw: unknown,
  request: PendingRequestMetadata,
  approvedPayload: PendingRequestPayload,
): DomainResult<"pending" | BlockingSessionRequestSuccess> {
  const found = snapshotDataRecord(raw, 5);
  if (!found || typeof found.outcome !== "string") return storageFailure();
  const keys = Object.keys(found).filter((key) => key !== "terminalized");
  const exact =
    found.outcome === "available_result"
      ? keys.length === 3 && keys.includes("metadata") && keys.includes("result")
      : found.outcome === "result_expired"
        ? keys.length === 2 && keys.includes("metadata")
        : keys.length === 3 && keys.includes("view") && keys.includes("metadata");
  if (!exact) return storageFailure();
  const metadata = inspectParticipantRequestMetadata(found.metadata);
  if (
    !metadata ||
    metadata.requestId !== request.id ||
    metadata.participantRole !== "source" ||
    metadata.sourceSessionId !== request.sourceSessionId ||
    metadata.targetSessionId !== request.targetSessionId ||
    metadata.kind !== request.kind
  ) {
    return storageFailure();
  }
  if (found.outcome === "metadata" && found.view === "source_pending") {
    return metadata.resolutionState === "pending"
      ? { ok: true, value: "pending" }
      : storageFailure();
  }
  if (found.outcome === "available_result") {
    if (
      metadata.resultState !== "available" ||
      metadata.resultAvailableAtMs !== metadata.resolvedAtMs ||
      metadata.resultExpiresAtMs === undefined ||
      metadata.resultExpiresAtMs < metadata.resultAvailableAtMs
    ) {
      return storageFailure();
    }
    let validated: ReturnType<typeof validateRetainedRequestResult>;
    try {
      const snapshot = snapshotResult(found.result);
      validated =
        approvedPayload.kind === "ask"
          ? validateAskResponseAgainstPendingPayload(snapshot, approvedPayload)
          : validateWaitRequestResult(snapshot);
    } catch {
      return storageFailure();
    }
    if (!validated.ok || validated.value.kind !== request.kind) return storageFailure();
    if (validated.value.kind === "ask" && metadata.resolutionState === "answered") {
      return {
        ok: true,
        value: {
          request_id: request.id,
          state: "answered",
          answers: validated.value.answers,
        },
      };
    }
    if (validated.value.kind === "wait" && metadata.resolutionState === "reached") {
      return {
        ok: true,
        value: {
          request_id: request.id,
          state: "reached",
          ...(validated.value.evidence === undefined ? {} : { evidence: validated.value.evidence }),
        },
      };
    }
    return storageFailure();
  }
  if (found.outcome === "result_expired") {
    return metadata.resultState === "expired" || metadata.resultState === "acknowledged"
      ? domainFailure(
          "result_expired",
          "The retained request result is no longer available.",
          false,
        )
      : storageFailure();
  }
  if (found.outcome !== "metadata" || found.view !== "source_unsuccessful_terminal") {
    return storageFailure();
  }
  return terminalFailure(metadata.resolutionState);
}

async function readAuthoritative(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  request: PendingRequestMetadata,
  approvedPayload: PendingRequestPayload,
  querySignal: AbortSignal,
): Promise<DomainResult<"pending" | BlockingSessionRequestSuccess>> {
  try {
    const settlement = await runUntilAborted(querySignal, () =>
      ports.requests.getParticipantRequest({
        fencingToken: context.fencingToken,
        workspaceKey: context.workspaceKey,
        requestId: request.id,
        callerSessionId: context.sourceSessionId,
      }),
    );
    if (settlement.kind !== "settled") {
      return domainFailure(
        "storage_unavailable",
        "Authoritative request state is unavailable.",
        true,
        {
          request_id: request.id,
        },
      );
    }
    const raw = settlement.value;
    if (!raw || !notifyTerminalizations(ports, context, request.id, raw)) return storageFailure();
    return sourceProjection(raw, request, approvedPayload);
  } catch (cause: unknown) {
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : storageFailure();
  }
}

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
): Promise<DomainResult<"pending" | BlockingSessionRequestSuccess>> {
  const controller = new AbortController();
  const interrupt = (signal: AbortSignal): void => controller.abort(signal.reason);
  const callerInterrupt = (): void => interrupt(context.abort);
  const localInterrupt = (): void => interrupt(localWake);
  try {
    context.abort.addEventListener("abort", callerInterrupt, { once: true });
    localWake.addEventListener("abort", localInterrupt, { once: true });
    if (context.abort.aborted) callerInterrupt();
    if (localWake.aborted) localInterrupt();
    return await readAuthoritative(ports, context, request, approvedPayload, controller.signal);
  } finally {
    context.abort.removeEventListener("abort", callerInterrupt);
    localWake.removeEventListener("abort", localInterrupt);
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
  let registration = provisional;
  let queryController = new AbortController();
  let cancelTask: Promise<DomainResult<BlockingSessionRequestSuccess>> | undefined;
  const onAbort = (): void => {
    queryController.abort("explicit_request_cancellation");
    cancelTask ??= cancelAfterAbort(ports, context, request, approvedPayload);
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
      const durable = await readForegroundAuthoritative(
        ports,
        context,
        request,
        approvedPayload,
        queryController.signal,
      );
      if (!durable.ok) {
        if (cancelTask) return await cancelTask;
        if (durable.error.code !== "storage_unavailable") return durable;
        return durable;
      } else if (durable.value !== "pending") {
        return { ok: true, value: durable.value };
      }
      const activeCancellation = cancelTask as
        | Promise<DomainResult<BlockingSessionRequestSuccess>>
        | undefined;
      const winner = activeCancellation
        ? await Promise.race([
            registration.outcome.then((outcome) => ({ type: "runtime" as const, outcome })),
            activeCancellation.then((result) => ({ type: "cancel" as const, result })),
          ])
        : { type: "runtime" as const, outcome: await registration.outcome };
      if (winner.type === "cancel") return winner.result;
      if (winner.type === "runtime") {
        if (winner.outcome.outcome === "shutdown") throw new RequestRuntimeShutdownFault();
        if (winner.outcome.outcome === "ownership_lost") {
          return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
        }
        // Runtime events are wake hints only. The fenced participant projection decides the winner.
      }
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
          ports,
          context,
          request,
          approvedPayload,
          new AbortController().signal,
        );
        if (!afterCapacityRace.ok || afterCapacityRace.value === "pending") {
          return afterCapacityRace.ok
            ? domainFailure(
                "storage_unavailable",
                "Request waiter capacity is unavailable.",
                true,
                {
                  request_id: request.id,
                },
              )
            : afterCapacityRace;
        }
        return { ok: true, value: afterCapacityRace.value };
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
