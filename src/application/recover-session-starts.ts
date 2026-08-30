import type { Sha256DigestPort } from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import { startRecoveryScanHardCeiling } from "../domain/safety-ceilings";
import type { StartOperation } from "../domain/session-start";
import { isCoherentStartOperation } from "../domain/session-start";
import type { WorkspaceKey } from "../domain/workspaces";
import type { ClockPort, CurrentWorkspaceMembershipPort, OwnershipPort } from "./delivery-ports";
import type { RequestAdmissionPersistencePort } from "./request-ports";
import type { SessionStartPorts } from "./session-start-application";
import type {
  NativeSessionStartPort,
  SessionRequestStartPersistencePort,
  StartOperationPersistencePort,
} from "./session-start-ports";
import { executeStartEffects } from "./start-session";
import { claimForEffect } from "./start-session-effect-preparation";
import { runStartCreation, runStartTitle } from "./start-session-effects";

export interface StartRecoverySummary {
  readonly preparedAwaitingInvocationApproval: number;
  readonly creationOutcomesUnknown: number;
  readonly titleOutcomesUnknown: number;
  readonly admissionsUnknown: number;
}

type RecoveredStartKind = "prepared" | "creation_unknown" | "title_unknown" | "admission_unknown";
type MutableStartRecoverySummary = {
  -readonly [Key in keyof StartRecoverySummary]: StartRecoverySummary[Key];
};

async function finishAmbiguousInitialStart(
  ports: SessionStartPorts,
  clock: ClockPort,
  input: Parameters<typeof recoverSessionStarts>[2],
  operation: StartOperation,
): Promise<void> {
  const context = {
    workspaceKey: input.workspaceKey,
    sourceSessionId: operation.sourceSessionId,
    abort: input.abort ?? new AbortController().signal,
    deadlineMs: Number.MAX_SAFE_INTEGER,
  };
  const creation = await runStartCreation(ports, context, input.fencingToken, operation);
  if (!creation.ok || creation.value.creationState !== "created") return;
  const title = await runStartTitle(ports, context, input.fencingToken, creation.value);
  if (!title.ok || title.value.admissionState !== "prepared") return;
  const claimed = await claimForEffect(
    ports,
    context,
    input.fencingToken,
    title.value,
    "admission",
  );
  if (!claimed.ok) throw new Error("Ambiguous linked initial admission could not be claimed.");
  const completed = await ports.starts.completeAdmission({
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    operationId: operation.id,
    state: "admission_unknown",
    nowMs: clock.nowMs(),
  });
  if (!completed.ok) throw new Error("Ambiguous linked initial admission could not be committed.");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linked initial-request recovery intentionally keeps claim, start effect, and one terminal delivery commit linear.
async function resumePreparedInitialRequest(
  starts: StartOperationPersistencePort,
  clock: ClockPort,
  input: Parameters<typeof recoverSessionStarts>[2],
  operation: StartOperation,
): Promise<boolean> {
  if (
    !input.requestStarts?.readSessionRequestStartByOperation ||
    !input.requests ||
    !input.membership ||
    !input.ownership ||
    !input.digest ||
    !input.nativeStart
  ) {
    return false;
  }
  const linked = await input.requestStarts.readSessionRequestStartByOperation({
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    operationId: operation.id,
  });
  if (!linked) return false;
  const effectPorts = {
    readiness: { fencingToken: input.fencingToken, assertReady() {} },
    membership: input.membership,
    starts,
    nativeStart: input.nativeStart,
    ownership: input.ownership,
    clock,
    digest: input.digest,
  } as unknown as SessionStartPorts;
  if (linked.request.resolutionState !== "pending") return true;
  if (linked.request.deliveryState === "delivery_unknown") {
    await finishAmbiguousInitialStart(effectPorts, clock, input, operation);
    return true;
  }
  if (
    linked.request.deliveryState !== "prepared" &&
    linked.request.deliveryState !== "submitting"
  ) {
    return true;
  }
  let claimedRequest = linked.request;
  if (linked.request.deliveryState === "prepared") {
    const claimed = await input.requests.claimPrepared({
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      requestId: linked.request.id,
    });
    if (!claimed.ok) throw new Error("Linked initial request recovery could not be claimed.");
    if (
      claimed.request.resolutionState !== "pending" ||
      claimed.request.deliveryState !== "submitting"
    ) {
      return true;
    }
    claimedRequest = claimed.request;
  }
  if (operation.admissionState === "admission_unknown") {
    const settled = await input.requests.completeDelivery({
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      requestId: claimedRequest.id,
      outcome: "delivery_unknown",
    });
    if (!settled.ok) throw new Error("Ambiguous linked initial request could not be completed.");
    return true;
  }
  if (operation.admissionState === "admitted" || operation.admissionState === "failed") {
    const base = {
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      requestId: claimedRequest.id,
    };
    const settled = await input.requests.completeDelivery(
      operation.admissionState === "admitted"
        ? {
            ...base,
            outcome: "admitted",
            nativeMessageId: claimedRequest.nativeMessageId,
            admittedSeq: 0,
            evidenceObservedAtMs: clock.nowMs(),
          }
        : { ...base, outcome: "delivery_failed" },
    );
    if (!settled.ok) throw new Error("Definitive linked initial request could not be completed.");
    return true;
  }
  const result = await executeStartEffects(
    effectPorts,
    {
      workspaceKey: input.workspaceKey,
      sourceSessionId: operation.sourceSessionId,
      abort: input.abort ?? new AbortController().signal,
      deadlineMs: Number.MAX_SAFE_INTEGER,
    },
    input.fencingToken,
    operation,
  );
  const completed = result.ok
    ? result.value
    : isCoherentStartOperation(result.error.details?.operation)
      ? result.error.details.operation
      : operation;
  const base = {
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    requestId: claimedRequest.id,
  };
  const outcome =
    completed.admissionState === "admitted"
      ? {
          ...base,
          outcome: "admitted" as const,
          nativeMessageId: claimedRequest.nativeMessageId,
          admittedSeq: 0,
          evidenceObservedAtMs: clock.nowMs(),
        }
      : completed.admissionState === "failed" || completed.creationState === "failed"
        ? { ...base, outcome: "delivery_failed" as const }
        : { ...base, outcome: "delivery_unknown" as const };
  const settled = await input.requests.completeDelivery(outcome);
  if (!settled.ok) throw new Error("Linked initial request recovery could not be completed.");
  return true;
}

async function classifyRecoverableStart(
  starts: StartOperationPersistencePort,
  clock: ClockPort,
  input: { readonly fencingToken: FencingToken; readonly workspaceKey: WorkspaceKey },
  operation: StartOperation,
): Promise<{ readonly kind: RecoveredStartKind; readonly operation: StartOperation }> {
  const step =
    operation.creationState === "submitting"
      ? "creation"
      : operation.titleState === "submitting"
        ? "title"
        : operation.admissionState === "submitting"
          ? "admission"
          : undefined;
  if (!step) return { kind: "prepared", operation };
  const result = await starts.classifyStaleSubmitting({
    ...input,
    operationId: operation.id,
    nowMs: clock.nowMs(),
    step,
  });
  if (!result.ok) throw new Error(`Start ${step} recovery could not be committed.`);
  return {
    kind:
      step === "creation"
        ? "creation_unknown"
        : step === "title"
          ? "title_unknown"
          : "admission_unknown",
    operation: result.operation,
  };
}

async function reconcileUnknownCreation(
  starts: StartOperationPersistencePort,
  native: NativeSessionStartPort,
  clock: ClockPort,
  input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly abort: AbortSignal;
  },
  operation: StartOperation,
): Promise<{
  readonly outcome: "matching" | "absent" | "collision" | "unknown";
  readonly operation: StartOperation;
}> {
  const outcome = await native.reconcileRootSession({
    sessionId: operation.sessionId,
    ...(operation.requestedAgent === undefined ? {} : { agent: operation.requestedAgent }),
    ...(operation.requestedModel === undefined ? {} : { model: operation.requestedModel }),
    abort: input.abort,
  });
  if (outcome === "unknown") return { outcome, operation };
  if (!["matching", "absent", "collision"].includes(outcome)) {
    throw new Error("Native start reconciliation returned a malformed outcome.");
  }
  const result = await starts.reconcileUnknownCreation({
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    operationId: operation.id,
    outcome,
    nowMs: clock.nowMs(),
  });
  if (!result.ok) throw new Error("Start creation reconciliation could not be committed.");
  return { outcome, operation: result.operation };
}

async function recoverOneStart(
  starts: StartOperationPersistencePort,
  clock: ClockPort,
  input: Parameters<typeof recoverSessionStarts>[2],
  operation: StartOperation,
  summary: MutableStartRecoverySummary,
): Promise<void> {
  const classified = await classifyRecoverableStart(starts, clock, input, operation);
  let current = classified.operation;
  if (classified.kind === "creation_unknown" || current.creationState === "outcome_unknown") {
    const reconciliation = input.nativeStart
      ? await reconcileUnknownCreation(
          starts,
          input.nativeStart,
          clock,
          {
            ...input,
            abort: input.abort ?? new AbortController().signal,
          },
          current,
        )
      : { outcome: "unknown" as const, operation: current };
    current = reconciliation.operation;
    if (reconciliation.outcome === "unknown") {
      summary.creationOutcomesUnknown += 1;
      return;
    }
  }
  if (await resumePreparedInitialRequest(starts, clock, input, current)) return;
  if (classified.kind === "title_unknown") summary.titleOutcomesUnknown += 1;
  else if (classified.kind === "admission_unknown") summary.admissionsUnknown += 1;
  else if (current.creationState === "prepared") summary.preparedAwaitingInvocationApproval += 1;
}

/** Reconciles crash boundaries only. Prepared work still needs fresh invocation-specific approval. */
export async function recoverSessionStarts(
  starts: StartOperationPersistencePort,
  clock: ClockPort,
  input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit?: number;
    readonly abort?: AbortSignal;
    readonly nativeStart?: NativeSessionStartPort;
    readonly requestStarts?: SessionRequestStartPersistencePort;
    readonly requests?: RequestAdmissionPersistencePort;
    readonly membership?: CurrentWorkspaceMembershipPort;
    readonly ownership?: OwnershipPort;
    readonly digest?: Sha256DigestPort;
  },
): Promise<StartRecoverySummary> {
  const limit = input.limit ?? startRecoveryScanHardCeiling;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > startRecoveryScanHardCeiling) {
    throw new TypeError("Start recovery limit is outside its immutable ceiling.");
  }
  const operations = await starts.listRecoverable({
    ...input,
    limit,
    excludeClaimedByToken: input.fencingToken,
  });
  if (operations.length === limit) {
    // v10's immutable trigger caps all recoverable operations at this exact ceiling. A caller that
    // chooses a smaller diagnostic limit cannot certify that startup recovery drained the set.
    if (limit !== startRecoveryScanHardCeiling) {
      throw new Error(
        "Start recovery limit cannot prove the immutable operation ceiling was drained.",
      );
    }
  }
  const summary: MutableStartRecoverySummary = {
    preparedAwaitingInvocationApproval: 0,
    creationOutcomesUnknown: 0,
    titleOutcomesUnknown: 0,
    admissionsUnknown: 0,
  };
  for (const operation of operations) {
    await recoverOneStart(starts, clock, input, operation, summary);
  }
  return Object.freeze(summary);
}
