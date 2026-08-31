import type { Hooks } from "@opencode-ai/plugin";
import type { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import type { CommunicatorStartupRecoveryLifecycle } from "../application/communicator-startup-lifecycle";
import type { ContextAdmissionRuntime } from "../application/context-admission-runtime";
import type { ParticipantDeletionLifecycle } from "../application/participant-deletion-lifecycle";
import type { ParticipantOperationGate } from "../application/participant-operation-gate";
import type { ParticipantStopLifecycle } from "../application/participant-stop-lifecycle";
import type { RequestRuntime } from "../application/request-runtime";
import type { ActiveInvocationRegistry } from "./active-invocations";
import type { constructToolContracts } from "./tools";

export type CommunicatorToolContracts = ReturnType<typeof constructToolContracts>;
type EventHook = NonNullable<Hooks["event"]>;
type ChatHook = NonNullable<Hooks["experimental.chat.messages.transform"]>;

export class CommunicatorGeneration {
  readonly fencingToken: CommunicatorStartupRecoveryLifecycle["fencingToken"];
  private quiesced = false;
  private resourceDisposal: Promise<void> | undefined;
  private deletionDisposal: Promise<void> | undefined;
  private stopDisposal: Promise<void> | undefined;
  private quiesceError: unknown;
  private readonly removeStopObserver: () => void;

  constructor(
    readonly store: LinuxBunSqliteStore,
    readonly runtime: RequestRuntime,
    readonly contextRuntime: ContextAdmissionRuntime,
    readonly lifecycle: CommunicatorStartupRecoveryLifecycle,
    readonly invocations: ActiveInvocationRegistry,
    readonly participantOperations: ParticipantOperationGate,
    private readonly deletion: ParticipantDeletionLifecycle,
    private readonly participantStop: ParticipantStopLifecycle,
    readonly contracts: CommunicatorToolContracts,
    readonly event: EventHook,
    readonly chat: ChatHook,
    private readonly exporterDrain?: () => Promise<void>,
    private readonly exporterDispose?: () => void,
    private readonly advisoryLockDrain?: () => Promise<void>,
    private readonly advisoryLockDispose?: () => void,
  ) {
    this.fencingToken = lifecycle.fencingToken;
    this.removeStopObserver = lifecycle.observeStop(() => this.quiesce());
  }

  quiesce(disposal = false): void {
    if (this.quiesced) return;
    this.quiesced = true;
    const capture = (operation: () => void): void => {
      try {
        operation();
      } catch (cause: unknown) {
        this.quiesceError ??= cause;
      }
    };
    capture(() =>
      this.invocations.closeAdmission(disposal ? "communicator_disposed" : "ownership_lost"),
    );
    capture(() => this.participantOperations.close());
    capture(() => {
      this.deletionDisposal = this.deletion.dispose();
    });
    capture(() => {
      this.stopDisposal = this.participantStop.dispose();
    });
    if (disposal) capture(() => this.lifecycle.stop("shutdown", "host_disposal"));
    capture(() => this.contextRuntime.stop(this.lifecycle.stopReason ?? "shutdown"));
    capture(() => this.advisoryLockDispose?.());
  }

  drainInvocations(): Promise<"drained" | "timed_out"> {
    return this.invocations.drain();
  }

  settleInvocations(): Promise<void> {
    return this.invocations.settled();
  }

  ownershipTakeoverDelayMs(): number {
    return this.store.ownershipTakeoverDelayMs();
  }

  disposeResources(): Promise<void> {
    this.resourceDisposal ??= this.disposeResourcesOnce();
    return this.resourceDisposal;
  }

  private async disposeResourcesOnce(): Promise<void> {
    let firstError: unknown = this.quiesceError;
    const capture = async (operation: (() => void | Promise<void>) | undefined): Promise<void> => {
      if (!operation) return;
      try {
        await operation();
      } catch (cause: unknown) {
        firstError ??= cause;
      }
    };
    this.removeStopObserver();
    await capture(() => this.stopDisposal);
    await capture(() => this.deletionDisposal);
    await capture(() => this.participantOperations.drain());
    await capture(this.advisoryLockDrain);
    await capture(() => this.lifecycle.scheduler.drain());
    await capture(this.exporterDrain);
    await capture(this.exporterDispose);
    await capture(() => this.store.close());
    if (firstError !== undefined) throw firstError;
  }
}
