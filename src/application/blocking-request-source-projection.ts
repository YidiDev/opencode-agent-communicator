import { OwnershipLostFault } from "../domain/ownership";
import {
  validateAskResponseAgainstPendingPayload,
  type validateRetainedRequestResult,
  validateWaitRequestResult,
} from "../domain/request-content";
import type { PendingRequestMetadata, PendingRequestPayload } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { runUntilAborted } from "./abortable-operation";
import type { BlockingSessionRequestSuccess } from "./blocking-request-wait-contracts";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
import { inspectParticipantRequestMetadata } from "./participant-request-boundaries";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

const storageFailure = (): DomainResult<never> =>
  domainFailure("storage_unavailable", "Request storage is unavailable.", true);

function notifyTerminalizations(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  expectedRequestId: string,
  raw: unknown,
): boolean {
  const found = snapshotDataRecord(raw, 5);
  if (!found || !Object.hasOwn(found, "terminalized")) return false;
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict authoritative projection validates every terminal state and result correlation.
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
  )
    return storageFailure();
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
    )
      return storageFailure();
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
        value: { request_id: request.id, state: "answered", answers: validated.value.answers },
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
  if (found.outcome !== "metadata" || found.view !== "source_unsuccessful_terminal")
    return storageFailure();
  return terminalFailure(metadata.resolutionState);
}

export async function readAuthoritativeRequest(
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
        { request_id: request.id },
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
