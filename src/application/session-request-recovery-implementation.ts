import type { RequestId } from "../domain/generated-ids";
import { OwnershipLostFault, validateFencingToken } from "../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../domain/request-identity";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { admitClaimedSessionRequest } from "./admit-claimed-session-request";
import type { OperationControl } from "./delivery-ports";
import {
  type PreparedSessionRequestRecoverySummary,
  type RequestParticipantActivityObservation,
  type RequestStoreFailureCode,
  requestStoreFailureCodes,
  type SessionRequestRecoveryPhaseInput,
  type SessionRequestRecoveryPorts,
} from "./request-ports";
import {
  inspectParticipantObservation,
  inspectRequestMetadata,
} from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { operationControlStopped } from "./safe-clock";
import {
  requestStartupPendingRecoveryMaximumRecords,
  requestStartupSubmittingRecoveryMaximumRecords,
} from "./session-request-recovery-limits";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

function requestFailure(code: RequestStoreFailureCode): DomainResult<never> {
  const message =
    code === "ownership_lost"
      ? "Coordinator ownership was lost."
      : code === "state_conflict"
        ? "Request recovery state is inconsistent."
        : "Request recovery storage is unavailable.";
  return domainFailure(code, message, code === "storage_unavailable" || code === "rate_limited");
}

function rejectedRequestFailure(cause: unknown, message: string): DomainResult<never> {
  return cause instanceof OwnershipLostFault
    ? requestFailure("ownership_lost")
    : domainFailure("storage_unavailable", message, true);
}

function validPhaseInput(input: SessionRequestRecoveryPhaseInput): boolean {
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

function controlStopped(ports: SessionRequestRecoveryPorts, input: OperationControl): boolean {
  return operationControlStopped(ports.clock, input.abort, input.deadlineMs);
}

function validStoreFailure(value: unknown): value is RequestStoreFailureCode {
  return typeof value === "string" && requestStoreFailureCodes.some((code) => code === value);
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return snapshotDataRecord(value, 30);
}

function snapshotRecoveryRequest(
  request: unknown,
  workspaceKey: WorkspaceKey,
  state: "prepared" | "submitting",
): RequestMetadata | undefined {
  const snapshot = inspectRequestMetadata(request);
  return snapshot && snapshot.workspaceKey === workspaceKey && snapshot.deliveryState === state
    ? snapshot
    : undefined;
}

async function classifyOneStaleRequest(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
  request: RequestMetadata,
): Promise<DomainResult<undefined>> {
  if (controlStopped(ports, input)) return requestFailure("ownership_lost");
  const current = await runUntilAborted(input.effectSignal, () =>
    ports.ownership.isCurrent(input.fencingToken),
  );
  if (current.kind === "aborted") return requestFailure("ownership_lost");
  if (current.kind === "rejected") {
    return rejectedRequestFailure(current.cause, "Request recovery storage is unavailable.");
  }
  if (current.value !== true) return requestFailure("ownership_lost");
  let rawCompletion: unknown;
  try {
    const settlement = await runUntilAborted(input.effectSignal, () =>
      ports.requests.completeDelivery({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        requestId: request.id,
        outcome: "delivery_unknown",
      }),
    );
    if (settlement.kind === "aborted") return requestFailure("ownership_lost");
    if (settlement.kind === "rejected") {
      return rejectedRequestFailure(settlement.cause, "Request recovery storage is unavailable.");
    }
    rawCompletion = settlement.value;
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) return requestFailure("ownership_lost");
    return domainFailure("storage_unavailable", "Request recovery storage is unavailable.", true);
  }
  const completion = snapshotDataRecord(rawCompletion, 2);
  if (!completion) return requestFailure("storage_unavailable");
  if (completion.ok === false) {
    return validStoreFailure(completion.code)
      ? requestFailure(completion.code)
      : requestFailure("storage_unavailable");
  }
  const committed = inspectRequestMetadata(completion.request);
  if (
    completion.ok !== true ||
    !committed ||
    !isCoherentRequestMetadata(committed) ||
    !hasRequestIdentity(snapshotRequestIdentity(request), committed) ||
    committed.deliveryState !== "delivery_unknown"
  ) {
    return requestFailure("storage_unavailable");
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
  if (!validPhaseInput(input)) {
    return domainFailure("invalid_arguments", "Request recovery phase input is invalid.", false);
  }
  if (input.startupBarrier.fencingToken !== input.fencingToken)
    return requestFailure("ownership_lost");
  const seen = new Set<RequestId>();
  let changed = 0;
  while (true) {
    if (controlStopped(ports, input)) return requestFailure("ownership_lost");
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
      if (residual.kind === "aborted") return requestFailure("ownership_lost");
      if (residual.kind === "rejected") {
        return rejectedRequestFailure(residual.cause, "Request recovery storage is unavailable.");
      }
      const remaining = snapshotDenseArray(residual.value, 1);
      return remaining?.length === 0
        ? { ok: true, value: changed }
        : requestFailure("storage_unavailable");
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
      if (settlement.kind === "aborted") return requestFailure("ownership_lost");
      if (settlement.kind === "rejected") {
        return rejectedRequestFailure(settlement.cause, "Request recovery storage is unavailable.");
      }
      records = settlement.value;
    } catch (cause: unknown) {
      if (cause instanceof OwnershipLostFault) return requestFailure("ownership_lost");
      return domainFailure("storage_unavailable", "Request recovery storage is unavailable.", true);
    }
    const batch = snapshotDenseArray(
      records,
      Math.min(input.limit, requestStartupSubmittingRecoveryMaximumRecords - seen.size),
    );
    if (!batch) return requestFailure("storage_unavailable");
    if (batch.length === 0) return { ok: true, value: changed };
    for (const rawRequest of batch) {
      const request = snapshotRecoveryRequest(rawRequest, input.workspaceKey, "submitting");
      if (
        !request ||
        seen.has(request.id) ||
        seen.size >= requestStartupSubmittingRecoveryMaximumRecords
      ) {
        return requestFailure("storage_unavailable");
      }
      seen.add(request.id);
      const classified = await classifyOneStaleRequest(ports, input, request);
      if (!classified.ok) return classified;
      changed += 1;
    }
  }
}

function inspectClaim(
  value: unknown,
  original: RequestMetadata,
): DomainResult<Readonly<{ readonly request: RequestMetadata; readonly envelope?: string }>> {
  const claim = recordObject(value);
  if (!claim) return requestFailure("storage_unavailable");
  const keys = Object.keys(claim);
  if (claim.ok === false) {
    return keys.length === 2 && keys.includes("code") && validStoreFailure(claim.code)
      ? requestFailure(claim.code)
      : requestFailure("storage_unavailable");
  }
  const request = inspectRequestMetadata(claim.request);
  if (
    claim.ok !== true ||
    !keys.includes("request") ||
    (keys.length !== 2 && keys.length !== 3) ||
    (keys.length === 3 && !keys.includes("envelopeJson")) ||
    !request ||
    !isCoherentRequestMetadata(request) ||
    !hasRequestIdentity(snapshotRequestIdentity(original), request)
  ) {
    return requestFailure("storage_unavailable");
  }
  if (claim.envelopeJson !== undefined && typeof claim.envelopeJson !== "string") {
    return requestFailure("storage_unavailable");
  }
  return {
    ok: true,
    value: Object.freeze({
      request,
      ...(typeof claim.envelopeJson === "string" ? { envelope: claim.envelopeJson } : {}),
    }),
  };
}

type PreparedRecoveryDecision = "submitted" | "skipped" | "terminalized";
type PreparedRecoveryCursor = Readonly<{ readonly createdAtMs: number; readonly id: RequestId }>;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: activity, claim, ownership, and admission failures require distinct externally safe mappings.
async function recoverOnePreparedRequest(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
  request: RequestMetadata,
): Promise<DomainResult<PreparedRecoveryDecision>> {
  if (input.effectSignal.aborted || controlStopped(ports, input)) {
    return requestFailure("ownership_lost");
  }
  let promise: Promise<RequestParticipantActivityObservation>;
  try {
    promise = ports.activity.observeRequestParticipants(
      input.workspaceKey,
      request.sourceSessionId,
      request.targetSessionId,
      input.effectSignal,
    );
  } catch {
    return domainFailure("native_unavailable", "Current request activity is unavailable.", true);
  }
  const settlement = await runUntilAborted(input.effectSignal, () => promise);
  if (settlement.kind === "aborted") return requestFailure("ownership_lost");
  if (settlement.kind === "rejected") {
    if (settlement.cause instanceof OwnershipLostFault) return requestFailure("ownership_lost");
    return domainFailure("native_unavailable", "Current request activity is unavailable.", true);
  }
  const observed: unknown = settlement.value;
  const activity = inspectParticipantObservation(observed);
  if (!activity) {
    return domainFailure("native_unavailable", "Current request activity is malformed.", true);
  }
  if (controlStopped(ports, input)) return requestFailure("ownership_lost");
  if (
    !activity.sourceVisible ||
    !activity.targetVisible ||
    (activity.targetStatus !== "busy" && activity.targetStatus !== "retry")
  ) {
    return { ok: true, value: "skipped" };
  }
  let claimed: unknown;
  try {
    const settlement = await runUntilAborted(input.effectSignal, () =>
      ports.requests.claimPrepared({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        requestId: request.id,
      }),
    );
    if (settlement.kind === "aborted") return requestFailure("ownership_lost");
    if (settlement.kind === "rejected") {
      return rejectedRequestFailure(settlement.cause, "Request claim storage is unavailable.");
    }
    claimed = settlement.value;
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) return requestFailure("ownership_lost");
    return domainFailure("storage_unavailable", "Request claim storage is unavailable.", true);
  }
  const claim = inspectClaim(claimed, request);
  if (!claim.ok) return claim;
  if (claim.value.request.deliveryState !== "submitting" || claim.value.envelope === undefined) {
    if (claim.value.request.resolutionState === "pending") return { ok: true, value: "skipped" };
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(claim.value.request));
    return { ok: true, value: "terminalized" };
  }
  const admission = await admitClaimedSessionRequest(ports, {
    workspaceKey: input.workspaceKey,
    fencingToken: input.fencingToken,
    request: claim.value.request,
    envelope: claim.value.envelope,
    control: input,
    effectSignal: input.effectSignal,
  });
  return admission.ok ? { ok: true, value: "submitted" } : admission;
}

async function readPreparedRecoveryPage(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
  cursor: PreparedRecoveryCursor | undefined,
  limit = input.limit,
): Promise<DomainResult<readonly RequestMetadata[]>> {
  let records: unknown;
  try {
    const settlement = await runUntilAborted(input.effectSignal, () =>
      ports.requests.listRecoverableRequests({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        state: "prepared",
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    if (settlement.kind === "aborted") return requestFailure("ownership_lost");
    if (settlement.kind === "rejected") {
      return rejectedRequestFailure(settlement.cause, "Request recovery storage is unavailable.");
    }
    records = settlement.value;
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) return requestFailure("ownership_lost");
    return domainFailure("storage_unavailable", "Request recovery storage is unavailable.", true);
  }
  const batch = snapshotDenseArray(records, limit);
  if (!batch) return requestFailure("storage_unavailable");
  const snapshots: RequestMetadata[] = [];
  for (const raw of batch) {
    const snapshot = inspectRequestMetadata(raw);
    if (!snapshot) return requestFailure("storage_unavailable");
    snapshots.push(snapshot as unknown as RequestMetadata);
  }
  return { ok: true, value: snapshots };
}

function inspectPreparedPage(
  records: readonly RequestMetadata[],
  workspaceKey: WorkspaceKey,
  previous: PreparedRecoveryCursor | undefined,
  seen: Set<RequestId>,
): DomainResult<PreparedRecoveryCursor | undefined> {
  let cursor = previous;
  for (const request of records) {
    const afterCursor =
      cursor === undefined ||
      request.createdAtMs > cursor.createdAtMs ||
      (request.createdAtMs === cursor.createdAtMs && request.id > cursor.id);
    if (
      !snapshotRecoveryRequest(request, workspaceKey, "prepared") ||
      request.resolutionState !== "pending" ||
      seen.has(request.id) ||
      seen.size >= requestStartupPendingRecoveryMaximumRecords ||
      !afterCursor
    ) {
      return requestFailure("storage_unavailable");
    }
    seen.add(request.id);
    cursor = Object.freeze({ createdAtMs: request.createdAtMs, id: request.id });
  }
  return { ok: true, value: cursor };
}

function preparedSummary(
  seen: ReadonlySet<RequestId>,
  counts: Readonly<Record<PreparedRecoveryDecision, number>>,
): DomainResult<PreparedSessionRequestRecoverySummary> {
  return {
    ok: true,
    value: {
      observed: seen.size,
      submitted: counts.submitted,
      skipped: counts.skipped,
      terminalizedAtClaim: counts.terminalized,
    },
  };
}

async function verifyPreparedResidual(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
  seen: ReadonlySet<RequestId>,
): Promise<DomainResult<undefined>> {
  const residual = await readPreparedRecoveryPage(ports, input, undefined, 1);
  if (!residual.ok) return residual;
  for (const request of residual.value) {
    if (
      !snapshotRecoveryRequest(request, input.workspaceKey, "prepared") ||
      !seen.has(request.id)
    ) {
      return requestFailure("storage_unavailable");
    }
  }
  return { ok: true, value: undefined };
}

async function recoverPreparedPage(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
  page: readonly RequestMetadata[],
  counts: Record<PreparedRecoveryDecision, number>,
): Promise<DomainResult<undefined>> {
  for (const request of page) {
    const recovered = await recoverOnePreparedRequest(ports, input, request);
    if (!recovered.ok) return recovered;
    counts[recovered.value] += 1;
  }
  return { ok: true, value: undefined };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one keyset traversal keeps the exact ceiling and residual proof adjacent to recovery effects.
export async function recoverPreparedSessionRequests(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
): Promise<DomainResult<PreparedSessionRequestRecoverySummary>> {
  if (!validPhaseInput(input)) {
    return domainFailure("invalid_arguments", "Request recovery phase input is invalid.", false);
  }
  if (input.startupBarrier.fencingToken !== input.fencingToken)
    return requestFailure("ownership_lost");
  const seen = new Set<RequestId>();
  let cursor: PreparedRecoveryCursor | undefined;
  const counts: Record<PreparedRecoveryDecision, number> = {
    submitted: 0,
    skipped: 0,
    terminalized: 0,
  };
  // Idle, unknown, or invisible targets intentionally remain durable prepared inbox work. Recovery
  // never polls, retries activity, or falls back to queue admission; a later normal wake may inspect it.
  while (true) {
    if (controlStopped(ports, input)) return requestFailure("ownership_lost");
    if (seen.size === requestStartupPendingRecoveryMaximumRecords) {
      const residual = await readPreparedRecoveryPage(ports, input, cursor, 1);
      if (!residual.ok) return residual;
      return residual.value.length === 0
        ? preparedSummary(seen, counts)
        : requestFailure("storage_unavailable");
    }
    const page = await readPreparedRecoveryPage(
      ports,
      {
        ...input,
        limit: Math.min(input.limit, requestStartupPendingRecoveryMaximumRecords - seen.size),
      },
      cursor,
    );
    if (!page.ok) return page;
    if (page.value.length === 0) {
      const residual = await verifyPreparedResidual(ports, input, seen);
      return residual.ok ? preparedSummary(seen, counts) : residual;
    }
    const inspected = inspectPreparedPage(page.value, input.workspaceKey, cursor, seen);
    if (!inspected.ok) return inspected;
    cursor = inspected.value;
    const recovered = await recoverPreparedPage(ports, input, page.value, counts);
    if (!recovered.ok) return recovered;
  }
}
