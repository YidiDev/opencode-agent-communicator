import { OwnershipUnavailableError } from "../adapters/store/store-types";

export type CommunicatorGenerationConstructionFailure =
  | "ownership_unavailable"
  | "ownership_lost"
  | "storage_failure"
  | "recovery_failed";

const constructionDiagnostics: Readonly<Record<CommunicatorGenerationConstructionFailure, string>> =
  Object.freeze({
    ownership_unavailable: "Communicator ownership is held by another backend.",
    ownership_lost: "Communicator ownership could not be established safely.",
    storage_failure: "Communicator storage became unavailable during recovery.",
    recovery_failed: "Communicator generation recovery failed.",
  });

export class CommunicatorGenerationConstructionError extends Error {
  override readonly name = "CommunicatorGenerationConstructionError";
  readonly diagnostic: string;

  constructor(readonly classification: CommunicatorGenerationConstructionFailure) {
    const diagnostic = constructionDiagnostics[classification];
    super(diagnostic);
    this.diagnostic = diagnostic;
  }
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

export function sanitizeGenerationConstructionError(
  cause: unknown,
): CommunicatorGenerationConstructionError {
  if (cause instanceof CommunicatorGenerationConstructionError) return cause;
  return new CommunicatorGenerationConstructionError(
    cause instanceof OwnershipUnavailableError ? "ownership_unavailable" : "recovery_failed",
  );
}
