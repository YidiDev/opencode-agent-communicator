import { OwnershipLostFault } from "../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../domain/request-identity";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { runUntilAborted } from "./abortable-operation";
import {
  blockingCheckpoint,
  type SessionBlockingRequestContext,
  type SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
import type { PrepareRequestInput, RequestStoreFailureCode } from "./request-ports";
import { requestStoreFailureCodes } from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import { snapshotDataRecord } from "./strict-port-boundaries";

const storageFailure = (): DomainResult<never> =>
  domainFailure("storage_unavailable", "Request storage is unavailable.", true);

function storeFailure(code: RequestStoreFailureCode): DomainResult<never> {
  if (code === "ownership_lost")
    return domainFailure(code, "Coordinator ownership was lost.", false);
  if (code === "quota_exceeded") return domainFailure(code, "Request quota is exhausted.", false);
  if (code === "rate_limited")
    return domainFailure(code, "Request creation is rate limited.", true);
  if (code === "deadlock_detected")
    return domainFailure(code, "The request would create a deadlock.", false);
  return storageFailure();
}

type PreparedCreateSettlement =
  | { readonly kind: "created"; readonly request: RequestMetadata }
  | { readonly kind: "rejected"; readonly result: DomainResult<never> }
  | { readonly kind: "ambiguous" };

function inspectPreparedCreate(raw: unknown, expected: RequestMetadata): PreparedCreateSettlement {
  const result = snapshotDataRecord(raw, 2);
  if (!result || Object.keys(result).length !== 2) return { kind: "ambiguous" };
  if (result.ok === false) {
    return typeof result.code === "string" &&
      requestStoreFailureCodes.includes(result.code as RequestStoreFailureCode)
      ? { kind: "rejected", result: storeFailure(result.code as RequestStoreFailureCode) }
      : { kind: "ambiguous" };
  }
  const request = inspectRequestMetadata(result.request);
  return result.ok === true &&
    request &&
    hasRequestIdentity(snapshotRequestIdentity(expected), request)
    ? { kind: "created", request }
    : { kind: "ambiguous" };
}

function inspectReconciliation(
  raw: unknown,
  expected: RequestMetadata,
): "absent" | "conflict" | RequestMetadata | undefined {
  const result = snapshotDataRecord(raw, 2);
  if (!result || typeof result.outcome !== "string") return undefined;
  if (result.outcome === "absent" || result.outcome === "conflict") {
    return Object.keys(result).length === 1 ? result.outcome : undefined;
  }
  if (result.outcome !== "matching" || Object.keys(result).length !== 2) return undefined;
  const request = inspectRequestMetadata(result.request);
  return request && hasRequestIdentity(snapshotRequestIdentity(expected), request)
    ? request
    : undefined;
}

async function reconcile(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  input: PrepareRequestInput,
) {
  const controller = new AbortController();
  let timer: { cancel(): void } | undefined;
  try {
    const nowMs = ports.clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return { kind: "aborted" as const };
    timer = ports.deadlineTimer.arm(Math.max(0, context.deadlineMs - nowMs), () =>
      controller.abort("creation_reconciliation_deadline"),
    );
    return await runUntilAborted(controller.signal, () =>
      ports.requests.reconcilePreparedCreation(input),
    );
  } catch (cause: unknown) {
    return { kind: "rejected" as const, cause };
  } finally {
    timer?.cancel();
  }
}

const unresolved = (requestId: string): DomainResult<never> =>
  domainFailure("storage_unavailable", "Request creation could not be reconciled.", true, {
    request_id: requestId,
  });

const unresolvedAfter = (requestId: string, ownershipLost: boolean): DomainResult<never> =>
  ownershipLost
    ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false, {
        request_id: requestId,
      })
    : unresolved(requestId);

// SQLite immediate transactions are finite; this bounded settlement handles only a lost Promise
// settlement and never permits an unbounded retry loop.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the two-attempt ambiguous-commit state machine remains linear and auditable.
export async function persistPreparedBlockingRequest(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  input: PrepareRequestInput,
): Promise<DomainResult<RequestMetadata>> {
  let rawCreated: unknown;
  let ownershipLost = false;
  const first = await runUntilAborted(context.abort, () => ports.requests.createPrepared(input));
  if (first.kind === "settled") rawCreated = first.value;
  if (first.kind === "rejected" && first.cause instanceof OwnershipLostFault) ownershipLost = true;
  let settlement = inspectPreparedCreate(rawCreated, input.request);
  if (settlement.kind === "rejected") return settlement.result;
  if (settlement.kind === "ambiguous") {
    const checked = await reconcile(ports, context, input);
    if (checked.kind !== "settled") return unresolvedAfter(input.request.id, ownershipLost);
    let observed = inspectReconciliation(checked.value, input.request);
    if (typeof observed === "object") settlement = { kind: "created", request: observed };
    else if (
      observed === "absent" &&
      !context.abort.aborted &&
      blockingCheckpoint(ports.clock, context).ok
    ) {
      let retryRaw: unknown;
      const retry = await runUntilAborted(context.abort, () =>
        ports.requests.createPrepared(input),
      );
      if (retry.kind === "settled") retryRaw = retry.value;
      if (retry.kind === "rejected" && retry.cause instanceof OwnershipLostFault)
        ownershipLost = true;
      settlement = inspectPreparedCreate(retryRaw, input.request);
      if (settlement.kind === "ambiguous") {
        const afterRetry = await reconcile(ports, context, input);
        observed =
          afterRetry.kind === "settled"
            ? inspectReconciliation(afterRetry.value, input.request)
            : undefined;
        settlement =
          typeof observed === "object"
            ? { kind: "created", request: observed }
            : { kind: "ambiguous" };
      }
    } else return unresolvedAfter(input.request.id, ownershipLost);
  }
  if (settlement.kind === "rejected") return settlement.result;
  if (settlement.kind === "created") return { ok: true, value: settlement.request };
  return unresolvedAfter(input.request.id, ownershipLost);
}
