import type { Hooks } from "@opencode-ai/plugin";
import type { InternalToolContract, StructuralToolContext } from "../tools/contracts";
import type { CommunicatorGeneration, CommunicatorToolContracts } from "./communicator-generation";
import { CommunicatorGenerationConstructionError } from "./communicator-generation-errors";
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
  disposeResources(): Promise<void>;
}

export type CommunicatorTerminalClassification =
  | "ownership_unavailable"
  | "ownership_lost"
  | "storage_failure"
  | "contract_fault"
  | "workflow_fault"
  | "drain_timeout"
  | "recovery_failed"
  | "host_disposal";

export interface CommunicatorTerminalState {
  readonly classification: CommunicatorTerminalClassification;
  readonly diagnostic: string;
}

class CommunicatorGenerationRecoveryError extends Error {
  override readonly name = "CommunicatorGenerationRecoveryError";

  constructor(
    readonly classification: CommunicatorTerminalClassification,
    message: string,
  ) {
    super(message);
  }
}

function classifyRecoveryFailure(cause: unknown): CommunicatorGenerationRecoveryError {
  if (cause instanceof CommunicatorGenerationRecoveryError) return cause;
  if (cause instanceof CommunicatorGenerationConstructionError) {
    const classification =
      cause.classification === "ownership_unavailable"
        ? "ownership_unavailable"
        : cause.classification === "ownership_lost"
          ? "ownership_lost"
          : cause.classification === "storage_failure"
            ? "storage_failure"
            : "recovery_failed";
    return new CommunicatorGenerationRecoveryError(classification, cause.diagnostic);
  }
  return new CommunicatorGenerationRecoveryError(
    "recovery_failed",
    "Communicator generation recovery failed.",
  );
}

export class CommunicatorGenerationManager {
  private currentValue: CommunicatorGenerationHandle;
  private stateValue: CommunicatorGenerationManagerState = "active";
  private recovery: Promise<CommunicatorGenerationHandle> | undefined;
  private disposal: Promise<void> | undefined;
  private terminalValue: CommunicatorTerminalState | undefined;
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
    const generation = await this.ensureReady();
    return generation.invocations.run(caller, (abort) =>
      operation(generation.contracts[id], { ...context, abort }),
    );
  }

  async routeEvent(...arguments_: Parameters<NonNullable<Hooks["event"]>>): Promise<void> {
    if (this.stateValue === "disposed") return;
    await this.currentValue.event(...arguments_);
  }

  async routeChat(
    ...arguments_: Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>
  ): Promise<void> {
    if (this.stateValue === "disposed") return;
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
      const drained = await generation.drainInvocations();
      if (drained === "timed_out") await generation.settleInvocations();
      await generation.disposeResources();
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
    this.stateValue = "recovering";
    const deadlineMs = this.recoveryDelay.nowMs() + this.startupDeadlineMs;
    if (!Number.isSafeInteger(deadlineMs)) {
      this.stateValue = "failed";
      this.setTerminal("contract_fault", "Communicator recovery timing is invalid.");
      throw new Error(this.terminalValue?.diagnostic);
    }
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
      const takeoverDelayMs = stale.ownershipTakeoverDelayMs();
      await stale.disposeResources();
      if (this.stateValue === "disposed") throw new Error("Communicator has been disposed.");
      await this.waitForTakeover(takeoverDelayMs, deadlineMs);
      const successor = await this.createGeneration(deadlineMs, this.recoveryAbort.signal);
      if (successor.fencingToken <= stale.fencingToken) {
        successor.quiesce();
        if ((await successor.drainInvocations()) === "drained") await successor.disposeResources();
        throw new CommunicatorGenerationRecoveryError(
          "ownership_unavailable",
          "Communicator recovery did not advance ownership.",
        );
      }
      if (this.isDisposed()) {
        successor.quiesce(true);
        if ((await successor.drainInvocations()) === "drained") await successor.disposeResources();
        throw new Error("Communicator has been disposed.");
      }
      this.currentValue = successor;
      this.stateValue = "active";
      return successor;
    } catch (cause: unknown) {
      if (this.stateValue !== "disposed") this.stateValue = "failed";
      if (this.stateValue === "disposed") {
        throw new Error(this.terminalValue?.diagnostic ?? "The communicator host was disposed.");
      }
      const failure = classifyRecoveryFailure(cause);
      this.setTerminal(failure.classification, failure.message);
      throw new Error(this.terminalValue?.diagnostic);
    }
  }

  private async waitForTakeover(delayMs: number, deadlineMs: number): Promise<void> {
    const nowMs = this.recoveryDelay.nowMs();
    if (
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      !Number.isSafeInteger(nowMs) ||
      nowMs >= deadlineMs
    ) {
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
    if (delayMs >= remainingMs || this.recoveryDelay.nowMs() >= deadlineMs) {
      throw new CommunicatorGenerationRecoveryError(
        "ownership_unavailable",
        "Communicator ownership recovery exceeded its startup deadline.",
      );
    }
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
