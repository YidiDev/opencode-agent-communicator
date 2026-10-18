import type { InternalToolContract, StructuralToolContext } from "../tools/contracts";
import type { CommunicatorGeneration, CommunicatorToolContracts } from "./communicator-generation";
import {
  CommunicatorGenerationRecoveryError,
  type CommunicatorTerminalClassification,
  classifyGenerationRecoveryFailure,
  readGenerationRecoveryClock,
  recoveryErrorForLifecycle,
} from "./communicator-generation-errors";
import {
  disposeQuiescedGeneration,
  disposeQuiescedGenerationStrict,
  disposeUnpublishedGeneration,
  inspectTakeoverAndDispose,
} from "./communicator-generation-rollback";
import type { GenerationRecoveryDelayPort } from "./generation-recovery-delay";

export type CommunicatorGenerationManagerState = "active" | "recovering" | "failed" | "disposed";

export interface CommunicatorGenerationHandle {
  readonly lifecycle: CommunicatorGeneration["lifecycle"];
  readonly invocations: CommunicatorGeneration["invocations"];
  readonly contracts: CommunicatorToolContracts;
  readonly fencingToken: CommunicatorGeneration["fencingToken"];
  readonly event: CommunicatorGeneration["event"];
  readonly chat: CommunicatorGeneration["chat"];
  quiesce(disposal?: boolean): void;
  drainInvocations(): Promise<"drained" | "timed_out">;
  settleInvocations(): Promise<void>;
  ownershipTakeoverDelayMs(): number;
  shutdownUnpublished(): void;
  disposeResources(): Promise<void>;
}

export type { CommunicatorTerminalClassification } from "./communicator-generation-errors";

export interface CommunicatorTerminalState {
  readonly classification: CommunicatorTerminalClassification;
  readonly diagnostic: string;
}

export class CommunicatorGenerationManager {
  private currentValue: CommunicatorGenerationHandle;
  private stateValue: CommunicatorGenerationManagerState = "active";
  private recovery: Promise<CommunicatorGenerationHandle> | undefined;
  private disposal: Promise<void> | undefined;
  private terminalValue: CommunicatorTerminalState | undefined;
  private terminalCleanup: Promise<void> | undefined;
  private readonly recoveryAbort = new AbortController();

  constructor(
    initial: CommunicatorGenerationHandle,
    private readonly createGeneration: (
      deadlineMs: number,
      abort: AbortSignal,
    ) => Promise<CommunicatorGenerationHandle>,
    private readonly recoveryDelay: GenerationRecoveryDelayPort,
    private readonly startupDeadlineMs: number,
  ) {
    this.currentValue = initial;
    if (!Number.isSafeInteger(startupDeadlineMs) || startupDeadlineMs < 1) {
      throw new TypeError("Generation recovery startup deadline is invalid.");
    }
  }

  get current(): CommunicatorGenerationHandle {
    return this.currentValue;
  }

  get state(): CommunicatorGenerationManagerState {
    return this.stateValue;
  }

  get terminalState(): CommunicatorTerminalState | undefined {
    return this.terminalValue;
  }

  descriptor<Key extends keyof CommunicatorToolContracts>(
    id: Key,
  ): Pick<CommunicatorToolContracts[Key], "args" | "description"> {
    const contract = this.currentValue.contracts[id];
    return { args: contract.args, description: contract.description };
  }

  async invoke(
    id: keyof CommunicatorToolContracts,
    caller: AbortSignal,
    operation: (
      contract: InternalToolContract<unknown>,
      context: StructuralToolContext,
    ) => Promise<string>,
    context: {
      readonly sessionID: string;
      readonly messageID?: string;
      readonly [legacyHostField: string]: unknown;
    },
  ): Promise<string> {
    let handoffs = 0;
    while (true) {
      this.assertCallerActive(caller);
      const generation = await this.ensureReady();
      this.assertCallerActive(caller);
      const result = await generation.invocations.runWithAdmission(caller, (abort) =>
        operation(generation.contracts[id], { ...context, abort }),
      );
      if (result.admitted) return result.value;
      if (result.reason === "cancelled") throw new Error("Communicator invocation was cancelled.");
      this.assertCallerActive(caller);
      if (handoffs >= 1) return this.failAdmissionHandoff();
      handoffs += 1;
    }
  }

  async routeEvent(
    ...arguments_: Parameters<CommunicatorGenerationHandle["event"]>
  ): Promise<void> {
    if (this.stateValue !== "active" || this.currentValue.lifecycle.status !== "ready") return;
    await this.currentValue.event(...arguments_);
  }

  async routeChat(...arguments_: Parameters<CommunicatorGenerationHandle["chat"]>): Promise<void> {
    if (this.stateValue !== "active" || this.currentValue.lifecycle.status !== "ready") return;
    await this.currentValue.chat(...arguments_);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stateValue = "disposed";
    this.setTerminal("host_disposal", "The communicator host was disposed.");
    this.recoveryAbort.abort("communicator_disposed");
    const generation = this.currentValue;
    generation.quiesce(true);
    this.disposal = (async () => {
      try {
        await this.recovery;
      } catch {}
      if (this.terminalCleanup) {
        await this.terminalCleanup;
        return;
      }
      await disposeQuiescedGenerationStrict(generation);
    })();
    return this.disposal;
  }

  private async ensureReady(): Promise<CommunicatorGenerationHandle> {
    if (this.stateValue === "disposed" || this.stateValue === "failed") {
      throw new Error(this.terminalValue?.diagnostic ?? "Communicator is unavailable.");
    }
    if (this.stateValue === "recovering")
      return this.recovery as Promise<CommunicatorGenerationHandle>;
    const generation = this.currentValue;
    if (generation.lifecycle.status === "ready") return generation;
    const stop = generation.lifecycle.stopState;
    const ownershipLost = stop?.recoverable && stop.cause === "ownership_lost";
    let expiredLeaseFault = false;
    try {
      expiredLeaseFault = this.expiredLeaseContractFault(stop, generation);
    } catch {
      this.stateValue = "failed";
      this.setTerminal("storage_failure", "Communicator storage became unavailable.");
      throw new Error("Communicator storage became unavailable.");
    }
    const ownershipRecoverable = ownershipLost || expiredLeaseFault;
    if (!ownershipRecoverable) {
      this.stateValue = "failed";
      const classification =
        stop?.cause === "storage_failure"
          ? "storage_failure"
          : stop?.cause === "workflow_fault"
            ? "workflow_fault"
            : "contract_fault";
      const diagnostic = stop?.diagnostic ?? "Communicator lifecycle is not ready.";
      this.setTerminal(classification, diagnostic);
      throw new Error(diagnostic);
    }
    let deadlineMs: number;
    try {
      deadlineMs =
        readGenerationRecoveryClock(() => this.recoveryDelay.nowMs()) + this.startupDeadlineMs;
    } catch {
      return this.failInvalidTiming();
    }
    if (!Number.isSafeInteger(deadlineMs)) return this.failInvalidTiming();
    this.stateValue = "recovering";
    this.recovery = this.replace(generation, deadlineMs);
    return this.recovery;
  }

  private async replace(
    stale: CommunicatorGenerationHandle,
    deadlineMs: number,
  ): Promise<CommunicatorGenerationHandle> {
    try {
      stale.quiesce();
      if ((await stale.drainInvocations()) !== "drained") {
        void stale
          .settleInvocations()
          .then(() => stale.disposeResources())
          .catch(() => undefined);
        throw new CommunicatorGenerationRecoveryError(
          "drain_timeout",
          "Communicator recovery invocation drain timed out.",
        );
      }
      const takeoverDelayMs = await inspectTakeoverAndDispose(stale);
      if (this.stateValue === "disposed") throw new Error("Communicator has been disposed.");
      await this.waitForTakeover(takeoverDelayMs, deadlineMs);
      const freeLease = takeoverDelayMs === 0;
      const successor = await this.buildReplacement(stale, deadlineMs, freeLease);
      this.currentValue = successor;
      this.stateValue = "active";
      return successor;
    } catch (cause: unknown) {
      if (this.stateValue !== "disposed") this.stateValue = "failed";
      if (this.stateValue === "disposed") {
        throw new Error(this.terminalValue?.diagnostic ?? "The communicator host was disposed.");
      }
      const failure = classifyGenerationRecoveryFailure(cause);
      this.setTerminal(failure.classification, failure.message);
      throw new Error(this.terminalValue?.diagnostic);
    }
  }

  private async waitForTakeover(delayMs: number, deadlineMs: number): Promise<void> {
    const nowMs = readGenerationRecoveryClock(() => this.recoveryDelay.nowMs());
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || nowMs >= deadlineMs) {
      throw new CommunicatorGenerationRecoveryError(
        "contract_fault",
        "Communicator recovery timing is invalid.",
      );
    }
    if (delayMs === 0) return;
    const remainingMs = deadlineMs - nowMs;
    const waitMs = Math.min(delayMs, remainingMs);
    const outcome = await this.recoveryDelay.wait(waitMs, this.recoveryAbort.signal);
    if (outcome === "aborted") throw new Error("Communicator recovery was interrupted.");
    const completedAtMs = readGenerationRecoveryClock(() => this.recoveryDelay.nowMs());
    if (delayMs >= remainingMs || completedAtMs >= deadlineMs) {
      throw new CommunicatorGenerationRecoveryError(
        "ownership_unavailable",
        "Communicator ownership recovery exceeded its startup deadline.",
      );
    }
  }

  private failureForLifecycle(
    generation: CommunicatorGenerationHandle,
  ): CommunicatorGenerationRecoveryError | undefined {
    return recoveryErrorForLifecycle(generation.lifecycle);
  }

  /**
   * A contract-fault stop on a generation whose ownership lease has already lapsed is an
   * ownership-recovery situation rather than a genuine port-contract violation: the expired
   * lease means no live contender owns the communicator, so a transient scheduler or recovery
   * port-contract violation during takeover must be retried by re-acquiring ownership instead of
   * failing the communicator permanently. Genuine contract violations and live contender
   * holdings (a positive takeover delay) remain terminal.
   */
  private expiredLeaseContractFault(
    stop: CommunicatorGenerationHandle["lifecycle"]["stopState"],
    generation: CommunicatorGenerationHandle,
  ): boolean {
    if (stop?.cause !== "contract_fault") return false;
    if (generation.ownershipTakeoverDelayMs() !== 0) return false;
    return this.stateValue !== "failed" && this.stateValue !== "disposed";
  }

  /**
   * Builds and validates the replacement generation, retrying a single successor attempt when it
   * fails with a contract fault exactly as the takeover began on a free lease. A scheduler or
   * recovery port-contract violation that recurs while the lease is unowned (for example a timing
   * contract that trips after a host wakes from sleep) is transient: disposing the failed attempt
   * releases its lease, and a fresh replacement re-acquires ownership with a higher fencing token.
   * The retry is bounded to one, preserves fail-closed behavior (a genuine violation, a non-free
   * lease, or a competitor that takes the lease mid-retry still terminates), and never runs while
   * the host is disposed.
   */
  private async buildReplacement(
    stale: CommunicatorGenerationHandle,
    deadlineMs: number,
    freeLease: boolean,
  ): Promise<CommunicatorGenerationHandle> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.buildCandidate(stale, deadlineMs);
      if (outcome.ok) return outcome.successor;
      if (attempt === 0 && this.shouldRetrySuccessorContractFault(outcome.failure, freeLease)) {
        continue;
      }
      throw outcome.failure;
    }
    throw new CommunicatorGenerationRecoveryError(
      "recovery_failed",
      "Communicator recovery could not build a successor.",
    );
  }

  private async buildCandidate(
    stale: CommunicatorGenerationHandle,
    deadlineMs: number,
  ): Promise<
    | { readonly ok: true; readonly successor: CommunicatorGenerationHandle }
    | { readonly ok: false; readonly failure: CommunicatorGenerationRecoveryError }
  > {
    let candidate: CommunicatorGenerationHandle | undefined;
    try {
      candidate = await this.createGeneration(deadlineMs, this.recoveryAbort.signal);
      const candidateFailure = this.failureForLifecycle(candidate);
      if (candidateFailure) {
        await disposeUnpublishedGeneration(candidate);
        return { ok: false, failure: candidateFailure };
      }
      if (candidate.fencingToken <= stale.fencingToken) {
        await disposeUnpublishedGeneration(candidate);
        return {
          ok: false,
          failure: new CommunicatorGenerationRecoveryError(
            "ownership_unavailable",
            "Communicator recovery did not advance ownership.",
          ),
        };
      }
      if (this.isDisposed()) {
        await disposeUnpublishedGeneration(candidate, true);
        throw new Error("Communicator has been disposed.");
      }
      const publicationFailure = this.failureForLifecycle(candidate);
      if (publicationFailure) {
        await disposeUnpublishedGeneration(candidate);
        return { ok: false, failure: publicationFailure };
      }
      return { ok: true, successor: candidate };
    } catch (cause: unknown) {
      if (candidate !== undefined) {
        try {
          await disposeUnpublishedGeneration(candidate);
        } catch {}
      }
      return { ok: false, failure: classifyGenerationRecoveryFailure(cause) };
    }
  }

  private shouldRetrySuccessorContractFault(
    failure: { readonly classification: CommunicatorTerminalClassification },
    freeLease: boolean,
  ): boolean {
    if (!freeLease) return false;
    if (this.stateValue === "disposed") return false;
    return failure.classification === "contract_fault";
  }

  private failInvalidTiming(): never {
    this.stateValue = "failed";
    this.setTerminal("contract_fault", "Communicator recovery timing is invalid.");
    throw new Error(this.terminalValue?.diagnostic);
  }

  private assertCallerActive(caller: AbortSignal): void {
    if (caller.aborted) throw new Error("Communicator invocation was cancelled.");
  }

  private failAdmissionHandoff(): never {
    if (this.stateValue === "disposed") {
      throw new Error(this.terminalValue?.diagnostic ?? "The communicator host was disposed.");
    }
    this.stateValue = "failed";
    this.setTerminal("contract_fault", "Communicator invocation admission handoff failed.");
    const generation = this.currentValue;
    try {
      generation.shutdownUnpublished();
    } catch {}
    this.terminalCleanup ??= disposeQuiescedGeneration(generation);
    void this.terminalCleanup.catch(() => undefined);
    throw new Error(this.terminalValue?.diagnostic);
  }

  private setTerminal(
    classification: CommunicatorTerminalClassification,
    diagnostic: string,
  ): void {
    this.terminalValue ??= Object.freeze({ classification, diagnostic });
  }

  private isDisposed(): boolean {
    return this.stateValue === "disposed";
  }
}
