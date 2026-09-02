import { OwnershipUnavailableError } from "../adapters/store/store-types";

export type CommunicatorGenerationConstructionFailure =
  | "ownership_unavailable"
  | "ownership_lost"
  | "storage_failure"
  | "contract_fault"
  | "workflow_fault"
  | "recovery_failed";

export type CommunicatorTerminalClassification =
  | CommunicatorGenerationConstructionFailure
  | "drain_timeout"
  | "host_disposal";

const constructionDiagnostics: Readonly<Record<CommunicatorGenerationConstructionFailure, string>> =
  Object.freeze({
    ownership_unavailable: "Communicator ownership is held by another backend.",
    ownership_lost: "Communicator ownership could not be established safely.",
    storage_failure: "Communicator storage became unavailable during recovery.",
    contract_fault: "A communicator port contract failed.",
    workflow_fault: "A communicator workflow faulted.",
    recovery_failed: "Communicator generation recovery failed.",
  });

export class CommunicatorGenerationConstructionError extends Error {
  override readonly name = "CommunicatorGenerationConstructionError";
  readonly diagnostic: string;

  constructor(
    readonly classification: CommunicatorGenerationConstructionFailure,
    diagnostic = constructionDiagnostics[classification],
  ) {
    super(diagnostic);
    this.diagnostic = diagnostic;
  }
}

export class CommunicatorGenerationRecoveryError extends Error {
  override readonly name = "CommunicatorGenerationRecoveryError";

  constructor(
    readonly classification: CommunicatorTerminalClassification,
    message: string,
  ) {
    super(message);
  }
}

export function classifyGenerationRecoveryFailure(
  cause: unknown,
): CommunicatorGenerationRecoveryError {
  if (cause instanceof CommunicatorGenerationRecoveryError) return cause;
  if (cause instanceof CommunicatorGenerationConstructionError) {
    return new CommunicatorGenerationRecoveryError(cause.classification, cause.diagnostic);
  }
  return new CommunicatorGenerationRecoveryError(
    "recovery_failed",
    "Communicator generation recovery failed.",
  );
}

export function readGenerationRecoveryClock(nowMs: () => number): number {
  let now: number;
  try {
    now = nowMs();
  } catch {
    throw new CommunicatorGenerationRecoveryError(
      "contract_fault",
      "Communicator recovery timing is invalid.",
    );
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new CommunicatorGenerationRecoveryError(
      "contract_fault",
      "Communicator recovery timing is invalid.",
    );
  }
  return now;
}

export function createCommunicatorStartupDeadline(nowMs: () => number, durationMs: number): number {
  let now: number;
  try {
    now = nowMs();
  } catch {
    throw new CommunicatorGenerationConstructionError(
      "contract_fault",
      "Communicator startup timing is invalid.",
    );
  }
  const deadlineMs = now + durationMs;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    !Number.isSafeInteger(deadlineMs)
  ) {
    throw new CommunicatorGenerationConstructionError(
      "contract_fault",
      "Communicator startup timing is invalid.",
    );
  }
  return deadlineMs;
}

export function constructionErrorForStartupCode(
  code: string,
  confirmedOwnershipContention = false,
): CommunicatorGenerationConstructionError {
  return new CommunicatorGenerationConstructionError(
    code === "ownership_lost"
      ? confirmedOwnershipContention
        ? "ownership_unavailable"
        : "ownership_lost"
      : code === "storage_unavailable"
        ? "storage_failure"
        : "recovery_failed",
  );
}

export class CommunicatorGenerationStartupCancelledError extends Error {
  override readonly name = "CommunicatorGenerationStartupCancelledError";

  constructor() {
    super("Communicator generation startup was cancelled.");
  }
}

export function assertGenerationStartupActive(abort: AbortSignal): void {
  if (abort.aborted) throw new CommunicatorGenerationStartupCancelledError();
}

export function assertGenerationStartupBoundary(
  abort: AbortSignal,
  deadlineMs: number,
  nowMs: () => number,
): void {
  assertGenerationStartupActive(abort);
  let now: number;
  try {
    now = nowMs();
  } catch {
    throw new CommunicatorGenerationConstructionError("contract_fault");
  }
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new CommunicatorGenerationConstructionError("contract_fault");
  }
  if (now >= deadlineMs) throw new CommunicatorGenerationConstructionError("ownership_lost");
}

export function constructionErrorForLifecycle(lifecycle: {
  readonly status: "starting" | "ready" | "stopped";
  readonly stopState:
    | {
        readonly cause:
          | "ownership_lost"
          | "storage_failure"
          | "contract_fault"
          | "workflow_fault"
          | "host_disposal";
        readonly diagnostic: string;
      }
    | undefined;
}): CommunicatorGenerationConstructionError | undefined {
  if (lifecycle.status === "ready") return undefined;
  const stop = lifecycle.stopState;
  const classification = stop?.cause === "host_disposal" ? "contract_fault" : stop?.cause;
  return new CommunicatorGenerationConstructionError(
    classification ?? "contract_fault",
    stop?.diagnostic ?? "Communicator lifecycle is not ready.",
  );
}

export function recoveryErrorForLifecycle(lifecycle: {
  readonly status: "starting" | "ready" | "stopped";
  readonly stopState:
    | {
        readonly cause:
          | "ownership_lost"
          | "storage_failure"
          | "contract_fault"
          | "workflow_fault"
          | "host_disposal";
        readonly diagnostic: string;
      }
    | undefined;
}): CommunicatorGenerationRecoveryError | undefined {
  const failure = constructionErrorForLifecycle(lifecycle);
  return failure
    ? new CommunicatorGenerationRecoveryError(failure.classification, failure.diagnostic)
    : undefined;
}

export function sanitizeGenerationConstructionError(
  cause: unknown,
): CommunicatorGenerationConstructionError {
  if (cause instanceof CommunicatorGenerationConstructionError) return cause;
  return new CommunicatorGenerationConstructionError(
    cause instanceof OwnershipUnavailableError ? "ownership_unavailable" : "recovery_failed",
  );
}
