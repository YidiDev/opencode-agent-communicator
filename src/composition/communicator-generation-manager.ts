import type { Hooks } from "@opencode-ai/plugin";
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
    context: Omit<StructuralToolContext, "abort">,
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

  async routeEvent(...arguments_: Parameters<NonNullable<Hooks["event"]>>): Promise<void> {
    if (this.stateValue !== "active" || this.currentValue.lifecycle.status !== "ready") return;
    await this.currentValue.event(...arguments_);
  }

  async routeChat(
    ...arguments_: Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>
  ): Promise<void> {
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
    if (!stop?.recoverable || stop.cause !== "ownership_lost") {
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
      const successor = await this.createGeneration(deadlineMs, this.recoveryAbort.signal);
      const successorFailure = this.failureForLifecycle(successor);
      if (successorFailure) {
        await disposeUnpublishedGeneration(successor);
        throw successorFailure;
      }
      if (successor.fencingToken <= stale.fencingToken) {
        const failure = new CommunicatorGenerationRecoveryError(
          "ownership_unavailable",
          "Communicator recovery did not advance ownership.",
        );
        await disposeUnpublishedGeneration(successor);
        throw failure;
      }
      if (this.isDisposed()) {
        const failure = new Error("Communicator has been disposed.");
        await disposeUnpublishedGeneration(successor, true);
        throw failure;
      }
      const publicationFailure = this.failureForLifecycle(successor);
      if (publicationFailure) {
        await disposeUnpublishedGeneration(successor);
        throw publicationFailure;
      }
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
