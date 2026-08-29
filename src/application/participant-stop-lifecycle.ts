import { participantDeletionCandidatesHardCeiling } from "../domain/safety-ceilings";
import { type SessionId, validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import type { CommunicatorStartupRecoveryLifecycle } from "./communicator-startup-lifecycle";
import type { ParticipantOperationPort } from "./participant-operation-gate";
import {
  ParticipantOperationAbortedFault,
  ParticipantOperationGateClosedFault,
} from "./participant-operation-gate";
import {
  isOpenCode118ParticipantActivityEvent,
  parseOpenCode118ParticipantActivityEvent,
} from "./participant-stop-evidence";
import type {
  NativeParticipantStopActivityPort,
  ParticipantStopPersistencePort,
} from "./participant-stop-ports";
import {
  ParticipantStopTerminalizationFault,
  terminalizeStoppedParticipant,
} from "./participant-stop-terminalization";
import { RequestDeadlineSchedulerFault } from "./request-deadline-scheduler";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export const participantStopMaximumConcurrentEvents = 64;
export const participantStopMaximumRememberedSessions = 1_024;
export const participantStopAntiEntropyIntervalMs = 30_000;

export interface ParticipantStopTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const nativeTimers: ParticipantStopTimerPort = {
  set: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ParticipantStopLifecycleOptions {
  readonly requests: ParticipantStopPersistencePort;
  readonly activity: NativeParticipantStopActivityPort;
  readonly operations: ParticipantOperationPort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly lifecycle: CommunicatorStartupRecoveryLifecycle;
  readonly workspaceKey: WorkspaceKey;
  readonly timers?: ParticipantStopTimerPort;
}

/** Lifecycle-owned bridge from native idle hints plus bounded anti-entropy to durable stops. */
export class ParticipantStopLifecycle {
  private readonly effects = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly inFlight = new Map<SessionId, Promise<boolean>>();
  private readonly rememberedIdle = new Set<SessionId>();
  private readonly timers: ParticipantStopTimerPort;
  private timerHandle: unknown;
  private timerArmed = false;
  private periodic: Promise<void> | undefined;
  private disposing = false;

  constructor(private readonly options: ParticipantStopLifecycleOptions) {
    this.timers = options.timers ?? nativeTimers;
    this.armPeriodic();
  }

  async handle(value: unknown): Promise<void> {
    if (!isOpenCode118ParticipantActivityEvent(value)) return;
    if (this.disposing || this.effects.signal.aborted || this.options.lifecycle.status !== "ready")
      return;
    let evidence: ReturnType<typeof parseOpenCode118ParticipantActivityEvent>;
    try {
      evidence = parseOpenCode118ParticipantActivityEvent(value);
      if (!evidence) throw new TypeError("OpenCode participant activity evidence is malformed.");
    } catch (cause: unknown) {
      this.fail("port_contract_violation");
      throw cause;
    }
    if (evidence.activity !== "idle") {
      this.rememberedIdle.delete(evidence.sessionId);
      return;
    }
    if (this.rememberedIdle.has(evidence.sessionId)) return;
    await this.runHint(evidence.sessionId);
  }

  async dispose(): Promise<void> {
    if (!this.disposing) {
      this.disposing = true;
      this.effects.abort("participant_stop_disposed");
      if (this.timerArmed) {
        this.timerArmed = false;
        this.timers.clear(this.timerHandle);
      }
    }
    await Promise.allSettled([...this.active]);
  }

  private async runHint(sessionId: SessionId): Promise<void> {
    const existing = this.inFlight.get(sessionId);
    if (existing) {
      await existing;
      return;
    }
    if (this.active.size >= participantStopMaximumConcurrentEvents) {
      this.fail("port_contract_violation");
      throw new Error("Participant stop event concurrency exceeded its hard bound.");
    }
    const operation = this.applyIfIdle(sessionId);
    this.inFlight.set(sessionId, operation);
    this.active.add(operation);
    try {
      if (await operation) this.remember(sessionId);
    } finally {
      this.active.delete(operation);
      this.inFlight.delete(sessionId);
    }
  }

  private async applyIfIdle(sessionId: SessionId): Promise<boolean> {
    try {
      return await this.options.operations.run([sessionId], this.effects.signal, async () => {
        const settlement = await runUntilAborted(this.effects.signal, () =>
          this.options.activity.observeParticipantActivity(
            this.options.workspaceKey,
            sessionId,
            this.effects.signal,
          ),
        );
        if (settlement.kind !== "settled") return false;
        const observed = settlement.value;
        if (observed !== "idle") {
          if (["busy", "retry", "not_visible", "unknown"].includes(observed)) return false;
          throw new ParticipantStopTerminalizationFault("port_contract_violation");
        }
        if (this.effects.signal.aborted) return false;
        await terminalizeStoppedParticipant({
          requests: this.options.requests,
          notifications: this.options.notifications,
          fencingToken: this.options.lifecycle.fencingToken,
          workspaceKey: this.options.workspaceKey,
          stoppedSessionId: sessionId,
        });
        return true;
      });
    } catch (cause: unknown) {
      if (
        cause instanceof ParticipantOperationAbortedFault ||
        cause instanceof ParticipantOperationGateClosedFault
      )
        return false;
      const code =
        cause instanceof ParticipantStopTerminalizationFault ? cause.code : "storage_failure";
      this.fail(code);
      throw new Error("Participant stop persistence failed closed.", { cause });
    }
  }

  private remember(sessionId: SessionId): void {
    this.rememberedIdle.add(sessionId);
    if (this.rememberedIdle.size <= participantStopMaximumRememberedSessions) return;
    const oldest = this.rememberedIdle.values().next().value;
    if (oldest !== undefined) this.rememberedIdle.delete(oldest);
  }

  private armPeriodic(): void {
    if (this.disposing || this.effects.signal.aborted || this.timerArmed) return;
    try {
      this.timerHandle = this.timers.set(participantStopAntiEntropyIntervalMs, () => {
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
      const raw: unknown = await this.options.requests.listParticipantDeletionCandidates({
        fencingToken: this.options.lifecycle.fencingToken,
        workspaceKey: this.options.workspaceKey,
      });
      const result = snapshotDataRecord(raw, 2);
      const values =
        result?.ok === true
          ? snapshotDenseArray(result.sessionIds, participantDeletionCandidatesHardCeiling)
          : undefined;
      if (!result || Object.keys(result).length !== 2 || !values) {
        const code =
          result?.ok === false && result.code === "ownership_lost"
            ? "ownership_lost"
            : "port_contract_violation";
        this.fail(code);
        return;
      }
      const seen = new Set<SessionId>();
      for (const value of values) {
        if (this.effects.signal.aborted) return;
        const id = validateSessionId(value);
        if (!id.ok || seen.has(id.value)) {
          this.fail("port_contract_violation");
          return;
        }
        seen.add(id.value);
        await this.applyIfIdle(id.value);
      }
    } catch {
      if (!this.effects.signal.aborted) {
        this.fail("storage_failure");
      }
    }
  }

  private fail(code: ConstructorParameters<typeof RequestDeadlineSchedulerFault>[0]): void {
    const fault = new RequestDeadlineSchedulerFault(code);
    this.effects.abort(`participant_stop_${code}`);
    if (this.timerArmed) {
      this.timerArmed = false;
      try {
        this.timers.clear(this.timerHandle);
      } catch {}
    }
    this.options.lifecycle.stop(code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
  }
}
