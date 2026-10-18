import { OwnershipLostFault } from "../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../domain/request-identity";
import type { PendingRequestMetadata, RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { runUntilAborted } from "./abortable-operation";
import { admitClaimedSessionRequest } from "./admit-claimed-session-request";
import {
  settleAdmissionCleanup as settleCleanup,
  settleAdmissionForeground as settleForeground,
  wakeAfterRequestAdmission as wake,
} from "./blocking-request-admission-settlement";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
import type { RequestClaimReconciliation } from "./request-ports";
import { type RequestStoreFailureCode, requestStoreFailureCodes } from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { snapshotDataRecord } from "./strict-port-boundaries";

const storageFailure = (): DomainResult<never> =>
  domainFailure("storage_unavailable", "Request storage is unavailable.", true);

function storeFailure(code: RequestStoreFailureCode): DomainResult<never> {
  if (code === "ownership_lost")
    return domainFailure(code, "Coordinator ownership was lost.", false);
  if (code === "quota_exceeded") return domainFailure(code, "Request quota is exhausted.", false);
  return storageFailure();
}

function parseStoreResult(raw: unknown, expected: RequestMetadata): DomainResult<RequestMetadata> {
  const result = snapshotDataRecord(raw, 2);
  if (!result) return storageFailure();
  const request = inspectRequestMetadata(result.request);
  return result.ok === true &&
    Object.keys(result).length === 2 &&
    request &&
    hasRequestIdentity(snapshotRequestIdentity(expected), request)
    ? { ok: true, value: request }
    : storageFailure();
}

function inspectClaimReconciliation(
  raw: unknown,
  expected: RequestMetadata,
): RequestClaimReconciliation | undefined {
  const data = snapshotDataRecord(raw, 3);
  if (!data || typeof data.outcome !== "string") return undefined;
  if (data.outcome === "absent_or_other_claim") {
    return Object.keys(data).length === 1 ? { outcome: "absent_or_other_claim" } : undefined;
  }
  const request = inspectRequestMetadata(data.request);
  if (!request || !hasRequestIdentity(snapshotRequestIdentity(expected), request)) return undefined;
  if (data.outcome === "still_prepared") {
    return Object.keys(data).length === 2 &&
      request.resolutionState === "pending" &&
      request.deliveryState === "prepared"
      ? { outcome: "still_prepared", request }
      : undefined;
  }
  if (data.outcome === "current_claim") {
    return Object.keys(data).length === 3 &&
      request.resolutionState === "pending" &&
      request.deliveryState === "submitting" &&
      typeof data.envelopeJson === "string"
      ? { outcome: "current_claim", request, envelopeJson: data.envelopeJson }
      : undefined;
  }
  if (data.outcome !== "settled" || Object.keys(data).length !== 2) return undefined;
  return request.resolutionState !== "pending" || request.deliveryState !== "submitting"
    ? { outcome: "settled", request }
    : undefined;
}

async function reconcileClaim(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  prepared: PendingRequestMetadata,
  cleanup = false,
): Promise<RequestClaimReconciliation | undefined> {
  const operation = () =>
    ports.requests.reconcilePreparedClaim({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId: prepared.id,
    });
  const settlement = cleanup
    ? await settleCleanup(ports, operation)
    : await settleForeground(ports, context, operation);
  return settlement.kind === "settled"
    ? inspectClaimReconciliation(settlement.value, prepared)
    : undefined;
}

async function faultSubmittingIfStillOwner(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
): Promise<void> {
  const ownership = await settleCleanup(ports, () =>
    ports.ownership.isCurrent(context.fencingToken),
  );
  if (ownership.kind !== "settled" || ownership.value !== true) return;
  try {
    ports.workflowFault.fault({
      fencingToken: context.fencingToken,
      reason: "request_admission_cleanup_unresolved",
    });
  } catch {
    // The owning workflow has already been conservatively classified as unsafe.
  }
}

async function classifyAmbiguousClaim(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  prepared: PendingRequestMetadata,
  supplied?: Awaited<ReturnType<SessionBlockingRequestPorts["requests"]["reconcilePreparedClaim"]>>,
): Promise<DomainResult<RequestMetadata> | undefined> {
  const raw = supplied ?? (await reconcileClaim(ports, context, prepared));
  if (!raw) return storageFailure();
  const reconciled = inspectClaimReconciliation(raw, prepared);
  if (!reconciled) return storageFailure();
  if (reconciled.outcome === "still_prepared") return undefined;
  if (reconciled.outcome === "settled") return { ok: true, value: reconciled.request };
  if (reconciled.outcome !== "current_claim") return undefined;
  let completed: DomainResult<RequestMetadata> = storageFailure();
  const completion = await settleCleanup(ports, () =>
    ports.requests.completeDelivery({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId: prepared.id,
      outcome: "delivery_unknown",
    }),
  );
  if (completion.kind === "settled") {
    completed = parseStoreResult(completion.value, reconciled.request);
  }
  if (completed.ok) return completed;
  const after = await reconcileClaim(ports, context, prepared, true);
  if (
    after?.outcome === "settled" &&
    after.request.deliveryState === "delivery_unknown" &&
    hasRequestIdentity(snapshotRequestIdentity(reconciled.request), after.request)
  ) {
    return { ok: true, value: after.request };
  }
  await faultSubmittingIfStillOwner(ports, context);
  wake(ports, prepared);
  return storageFailure();
}

async function reconcileBackgroundFailure(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  prepared: PendingRequestMetadata,
): Promise<void> {
  let provedNonSubmitting = false;
  try {
    for (let attempt = 0; attempt < 2 && !provedNonSubmitting; attempt += 1) {
      const claim = await reconcileClaim(ports, context, prepared, true);
      if (!claim) break;
      if (claim.outcome === "still_prepared" || claim.outcome === "settled") {
        provedNonSubmitting = true;
        break;
      }
      if (claim.outcome !== "current_claim") break;
      let completed: DomainResult<RequestMetadata> = storageFailure();
      const completion = await settleCleanup(ports, () =>
        ports.requests.completeDelivery({
          fencingToken: context.fencingToken,
          workspaceKey: context.workspaceKey,
          requestId: prepared.id,
          outcome: "delivery_unknown",
        }),
      );
      if (completion.kind === "settled") {
        completed = parseStoreResult(completion.value, claim.request);
      }
      provedNonSubmitting = completed.ok && completed.value.deliveryState !== "submitting";
    }
  } catch {
    provedNonSubmitting = false;
  } finally {
    if (!provedNonSubmitting) {
      await faultSubmittingIfStillOwner(ports, context);
    }
    wake(ports, prepared);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: claim ambiguity and single native admission remain one auditable boundary.
export async function claimAndAdmitBlockingRequest(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  prepared: PendingRequestMetadata,
  admissionController: AbortController,
): Promise<DomainResult<undefined>> {
  let raw: unknown;
  let ambiguous = prepared.deliveryState === "submitting";
  if (!ambiguous) {
    const settlement = await runUntilAborted(context.abort, () =>
      ports.requests.claimPrepared({
        fencingToken: context.fencingToken,
        workspaceKey: context.workspaceKey,
        requestId: prepared.id,
      }),
    );
    if (settlement.kind === "settled") raw = settlement.value;
    else ambiguous = true;
  }
  let claim = snapshotDataRecord(raw, 3);
  if (!claim || ambiguous) {
    try {
      let reconciledRaw = await reconcileClaim(ports, context, prepared, context.abort.aborted);
      if (!reconciledRaw) return storageFailure();
      if (reconciledRaw.outcome === "still_prepared") {
        let retried: unknown;
        const retry = await runUntilAborted(context.abort, () =>
          ports.requests.claimPrepared({
            fencingToken: context.fencingToken,
            workspaceKey: context.workspaceKey,
            requestId: prepared.id,
          }),
        );
        if (retry.kind === "settled") retried = retry.value;
        claim = snapshotDataRecord(retried, 3);
        if (!claim || (claim.ok !== true && claim.ok !== false)) {
          reconciledRaw = await reconcileClaim(ports, context, prepared, context.abort.aborted);
          if (!reconciledRaw) return storageFailure();
        }
      }
      if (claim && (claim.ok === true || claim.ok === false)) {
        // A well-formed retry is validated by the common claim boundary below.
      } else {
        const reconciled =
          reconciledRaw.outcome === "still_prepared"
            ? undefined
            : await classifyAmbiguousClaim(ports, context, prepared, reconciledRaw);
        if (!reconciled) return storageFailure();
        if (!reconciled.ok) return reconciled;
        if (reconciled.value.deliveryState === "delivery_unknown")
          return { ok: true, value: undefined };
        claim = { ok: true, request: reconciled.value };
      }
    } catch (cause: unknown) {
      return cause instanceof OwnershipLostFault
        ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
        : storageFailure();
    }
  }
  if (claim.ok === false)
    return Object.keys(claim).length === 2 &&
      typeof claim.code === "string" &&
      requestStoreFailureCodes.includes(claim.code as RequestStoreFailureCode)
      ? storeFailure(claim.code as RequestStoreFailureCode)
      : storageFailure();
  if (claim.ok !== true) return storageFailure();
  const request = inspectRequestMetadata(claim.request);
  if (!request || !hasRequestIdentity(snapshotRequestIdentity(prepared), request))
    return storageFailure();
  if (request.resolutionState !== "pending") {
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(request));
    return { ok: true, value: undefined };
  }
  if (request.deliveryState !== "submitting")
    return Object.keys(claim).length === 2 && claim.envelopeJson === undefined
      ? { ok: true, value: undefined }
      : storageFailure();
  if (typeof claim.envelopeJson !== "string" || Object.keys(claim).length !== 3)
    return storageFailure();
  const envelope = claim.envelopeJson;
  const supervised = runUntilAborted(context.abort, () =>
    admitClaimedSessionRequest(
      {
        ...ports,
        nativeQueue: ports.nativeQueue ?? {
          queueMessage: (input) => ports.nativeSteer.steerRequest(input),
        },
      },
      {
        workspaceKey: context.workspaceKey,
        fencingToken: context.fencingToken,
        request,
        envelope,
        control: {
          abort: admissionController.signal,
          deadlineMs: Math.min(context.deadlineMs, request.deadlineAtMs),
        },
        effectSignal: ports.runtime.effectSignal,
        callerAbortPersistsUnknown: true,
      },
    ),
  );
  void supervised.then(async (settlement) => {
    if (settlement.kind !== "settled" || !settlement.value.ok) {
      await reconcileBackgroundFailure(ports, context, prepared);
    }
  });
  return { ok: true, value: undefined };
}
