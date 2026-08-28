import type { WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorStartupRecoveryLifecycle } from "./communicator-startup-lifecycle";
import {
  isOpenCode118SessionDeletedEvent,
  parseOpenCode118SessionDeletedEvent,
} from "./participant-deletion-evidence";
import type {
  NativeParticipantPresencePort,
  ParticipantDeletionPersistencePort,
} from "./participant-deletion-ports";
import {
  applyParticipantDeletionHint,
  ParticipantDeletionReconciliationFault,
  reconcileParticipantDeletions,
} from "./participant-deletion-reconciliation";
import { RequestDeadlineSchedulerFault } from "./request-deadline-scheduler";
import type { CommittedRequestNotificationPort } from "./request-notification-port";

export const participantDeletionMaximumConcurrentEvents = 64;
export const participantDeletionMaximumRememberedSessions = 1_024;
export const participantDeletionAntiEntropyIntervalMs = 30_000;

export interface ParticipantDeletionTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const nativeTimers: ParticipantDeletionTimerPort = {
  set: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ParticipantDeletionLifecycleOptions {
  readonly requests: ParticipantDeletionPersistencePort;
  readonly presence: NativeParticipantPresencePort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly lifecycle: CommunicatorStartupRecoveryLifecycle;
  readonly workspaceKey: WorkspaceKey;
  readonly directory: string;
  readonly projectId: string;
  readonly timers?: ParticipantDeletionTimerPort;
}

/** Lifecycle-owned bridge from hook hints plus authoritative direct presence to durable state. */
export class ParticipantDeletionLifecycle {
  private readonly effects = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly completed = new Set<string>();
  private readonly timers: ParticipantDeletionTimerPort;
  private timerHandle: unknown;
  private timerArmed = false;
  private periodic: Promise<void> | undefined;
  private disposing = false;

  constructor(private readonly options: ParticipantDeletionLifecycleOptions) {
    this.timers = options.timers ?? nativeTimers;
    if (
      !Number.isSafeInteger(participantDeletionMaximumConcurrentEvents) ||
      !Number.isSafeInteger(participantDeletionMaximumRememberedSessions) ||
      options.projectId.length < 1 ||
      options.projectId.length > 512
    )
      throw new TypeError("Participant deletion lifecycle binding is malformed.");
    this.armPeriodic();
  }

  async handle(value: unknown): Promise<void> {
    if (!isOpenCode118SessionDeletedEvent(value)) return;
    if (this.disposing || this.effects.signal.aborted) return;
    if (this.options.lifecycle.status !== "ready") return;
    let evidence: ReturnType<typeof parseOpenCode118SessionDeletedEvent>;
    try {
      evidence = parseOpenCode118SessionDeletedEvent(value);
      if (!evidence) throw new TypeError("OpenCode session.deleted evidence is malformed.");
    } catch (cause: unknown) {
      this.fail("port_contract_violation");
      throw cause;
    }
    if (
      evidence.directory !== this.options.directory ||
      evidence.projectId !== this.options.projectId ||
      !evidence.isRoot ||
      this.effects.signal.aborted
    )
      return;
    if (this.completed.has(evidence.sessionId)) return;
    const existing = this.inFlight.get(evidence.sessionId);
    if (existing) {
      await existing;
      return;
    }
    // Duplicate evidence is coalesced above, before it can consume the unique-operation budget.
    if (this.active.size >= participantDeletionMaximumConcurrentEvents) {
      this.fail("port_contract_violation");
      throw new Error("Participant deletion event concurrency exceeded its hard bound.");
    }
    const operation = this.applyDeletionHint(evidence.sessionId);
    this.inFlight.set(evidence.sessionId, operation);
    this.active.add(operation);
    try {
      const applied = await operation;
      if (applied) {
        this.completed.add(evidence.sessionId);
        if (this.completed.size > participantDeletionMaximumRememberedSessions) {
          const oldest = this.completed.values().next().value;
          if (oldest !== undefined) this.completed.delete(oldest);
        }
      }
    } finally {
      this.active.delete(operation);
      if (this.inFlight.get(evidence.sessionId) === operation)
        this.inFlight.delete(evidence.sessionId);
    }
  }

  async dispose(): Promise<void> {
    if (!this.disposing) {
      this.disposing = true;
      this.effects.abort("participant_deletion_disposed");
      if (this.timerArmed) {
        this.timerArmed = false;
        this.timers.clear(this.timerHandle);
      }
    }
    await Promise.allSettled([...this.active]);
  }

  private async applyDeletionHint(
    deletedSessionId: import("../domain/sessions").SessionId,
  ): Promise<boolean> {
    try {
      return await applyParticipantDeletionHint(
        this.options,
        deletedSessionId,
        this.effects.signal,
      );
    } catch (cause: unknown) {
      const code =
        cause instanceof ParticipantDeletionReconciliationFault ? cause.code : "storage_failure";
      this.fail(code);
      if (cause instanceof ParticipantDeletionReconciliationFault && cause.cause !== undefined)
        throw cause.cause;
      throw new Error("Participant deletion persistence failed closed.", { cause });
    }
  }

  private armPeriodic(): void {
    if (this.disposing || this.effects.signal.aborted || this.timerArmed) return;
    try {
      this.timerHandle = this.timers.set(participantDeletionAntiEntropyIntervalMs, () => {
        this.timerArmed = false;
        this.periodic = this.runPeriodic();
        this.active.add(this.periodic);
        void this.periodic.finally(() => {
          if (this.periodic) this.active.delete(this.periodic);
          this.periodic = undefined;
          this.armPeriodic();
        });
      });
      this.timerArmed = true;
    } catch {
      this.fail("port_contract_violation");
    }
  }

  private async runPeriodic(): Promise<void> {
    if (this.disposing || this.options.lifecycle.status !== "ready") return;
    try {
      await reconcileParticipantDeletions(this.options, this.effects.signal);
    } catch (cause: unknown) {
      const code =
        cause instanceof ParticipantDeletionReconciliationFault ? cause.code : "storage_failure";
      this.fail(code);
    }
  }

  private fail(code: ConstructorParameters<typeof RequestDeadlineSchedulerFault>[0]): void {
    const fault = new RequestDeadlineSchedulerFault(code);
    this.effects.abort(`participant_deletion_${code}`);
    if (this.timerArmed) {
      this.timerArmed = false;
      try {
        this.timers.clear(this.timerHandle);
      } catch {
        // The original lifecycle fault remains causal; disposal will still drain active work.
      }
    }
    this.options.lifecycle.stop(code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
  }
}
