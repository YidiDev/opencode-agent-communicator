import type { RequestId } from "../domain/generated-ids";
import { OwnershipLostFault } from "../domain/ownership";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import {
  type PreparedRecoveryDecision,
  recoverOnePreparedSessionRequest,
} from "./recover-one-prepared-session-request";
import type {
  PreparedSessionRequestRecoverySummary,
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import { requestStartupPendingRecoveryMaximumRecords } from "./session-request-recovery-limits";
import {
  rejectedRequestRecoveryFailure,
  requestRecoveryFailure,
  sessionRequestRecoveryControlStopped,
  snapshotRecoveryRequest,
  validSessionRequestRecoveryPhaseInput,
} from "./session-request-recovery-support";
import { snapshotDenseArray } from "./strict-port-boundaries";

type PreparedRecoveryCursor = Readonly<{ readonly createdAtMs: number; readonly id: RequestId }>;

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
  const batch = snapshotDenseArray(records, limit);
  if (!batch) return requestRecoveryFailure("storage_unavailable");
  const snapshots: RequestMetadata[] = [];
  for (const raw of batch) {
    const snapshot = inspectRequestMetadata(raw);
    if (!snapshot) return requestRecoveryFailure("storage_unavailable");
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
      return requestRecoveryFailure("storage_unavailable");
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
      return requestRecoveryFailure("storage_unavailable");
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
    const recovered = await recoverOnePreparedSessionRequest(ports, input, request);
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
  if (!validSessionRequestRecoveryPhaseInput(input)) {
    return domainFailure("invalid_arguments", "Request recovery phase input is invalid.", false);
  }
  if (input.startupBarrier.fencingToken !== input.fencingToken) {
    return requestRecoveryFailure("ownership_lost");
  }
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
    if (sessionRequestRecoveryControlStopped(ports, input)) {
      return requestRecoveryFailure("ownership_lost");
    }
    if (seen.size === requestStartupPendingRecoveryMaximumRecords) {
      const residual = await readPreparedRecoveryPage(ports, input, cursor, 1);
      if (!residual.ok) return residual;
      return residual.value.length === 0
        ? preparedSummary(seen, counts)
        : requestRecoveryFailure("storage_unavailable");
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
