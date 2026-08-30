import type { FencingToken } from "../domain/ownership";
import { startRecoveryScanHardCeiling } from "../domain/safety-ceilings";
import type { StartOperation } from "../domain/session-start";
import type { WorkspaceKey } from "../domain/workspaces";
import type { ClockPort } from "./delivery-ports";
import {
  resumePreparedInitialRequest,
  type SessionStartRecoveryInput,
} from "./recover-session-request-starts";
import type { NativeSessionStartPort, StartOperationPersistencePort } from "./session-start-ports";

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
  input: SessionStartRecoveryInput,
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
  input: SessionStartRecoveryInput,
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

export type { SessionStartRecoveryInput } from "./recover-session-request-starts";
