import { participantStopCandidatesHardCeiling } from "../domain/safety-ceilings";
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
export const participantStopActivityBatchSize = 64;
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

function snapshotIdleSessionIds(raw: unknown, expectedIds: readonly SessionId[]): SessionId[] {
  const observations = snapshotDenseArray(raw, expectedIds.length);
  if (!observations || observations.length !== expectedIds.length) {
    throw new ParticipantStopTerminalizationFault("port_contract_violation");
  }
  const expected = new Set(expectedIds);
  const seen = new Set<SessionId>();
  const idle: SessionId[] = [];
  for (const value of observations) {
    const observation = snapshotDataRecord(value, 2);
    const id = observation && validateSessionId(observation.sessionId);
    if (
      !observation ||
      Object.keys(observation).length !== 2 ||
      !id?.ok ||
      !expected.has(id.value) ||
      seen.has(id.value) ||
      !["busy", "retry", "idle", "not_visible", "unknown"].includes(observation.activity as string)
    ) {
      throw new ParticipantStopTerminalizationFault("port_contract_violation");
    }
    seen.add(id.value);
    if (observation.activity === "idle") idle.push(id.value);
  }
  return idle;
}

function snapshotParticipantCandidates(raw: unknown):
  | { readonly ok: true; readonly sessionIds: readonly SessionId[] }
  | {
      readonly ok: false;
      readonly code: "ownership_lost" | "storage_failure" | "port_contract_violation";
    } {
  const result = snapshotDataRecord(raw, 2);
  if (
    result?.ok === false &&
    Object.keys(result).length === 2 &&
    (result.code === "ownership_lost" || result.code === "storage_unavailable")
  ) {
    return {
      ok: false,
      code: result.code === "ownership_lost" ? "ownership_lost" : "storage_failure",
    };
  }
  const values =
    result?.ok === true
      ? snapshotDenseArray(result.sessionIds, participantStopCandidatesHardCeiling)
      : undefined;
  if (!result || Object.keys(result).length !== 2 || !values) {
    return { ok: false, code: "port_contract_violation" };
  }
  const seen = new Set<SessionId>();
  for (const value of values) {
    const id = validateSessionId(value);
    if (!id.ok || seen.has(id.value)) {
      return { ok: false, code: "port_contract_violation" };
    }
    seen.add(id.value);
  }
  return { ok: true, sessionIds: [...seen] };
}

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
  private readonly timers: ParticipantStopTimerPort;
  private timerHandle: unknown;
  private timerArmed = false;
  private periodic: Promise<void> | undefined;
  private disposing = false;
  private handling = 0;
  private readonly onLifecycleStop = (): void => this.abortEffects("communicator_stopped");

  constructor(private readonly options: ParticipantStopLifecycleOptions) {
    this.timers = options.timers ?? nativeTimers;
    options.lifecycle.effectSignal.addEventListener("abort", this.onLifecycleStop, { once: true });
    if (options.lifecycle.effectSignal.aborted) this.onLifecycleStop();
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
    if (evidence.activity !== "idle") return;
    await this.runHint(evidence.sessionId);
  }

  async dispose(): Promise<void> {
    if (!this.disposing) {
      this.disposing = true;
      this.options.lifecycle.effectSignal.removeEventListener("abort", this.onLifecycleStop);
      this.abortEffects("participant_stop_disposed");
    }
    await Promise.allSettled([...this.active]);
  }

  private async runHint(sessionId: SessionId): Promise<void> {
    if (this.handling >= participantStopMaximumConcurrentEvents) {
      this.fail("port_contract_violation");
      throw new Error("Participant stop event concurrency exceeded its hard bound.");
    }
    this.handling += 1;
    try {
      const existing = this.inFlight.get(sessionId);
      if (existing) {
        await existing;
        return;
      }
      const operation = this.applyIfIdle(sessionId);
      this.inFlight.set(sessionId, operation);
      this.active.add(operation);
      try {
        await operation;
      } finally {
        this.active.delete(operation);
        this.inFlight.delete(sessionId);
      }
    } finally {
      this.handling -= 1;
    }
  }

  private async applyIfIdle(sessionId: SessionId): Promise<boolean> {
    return (await this.applyBatchIfIdle([sessionId])) > 0;
  }

  private async applyBatchIfIdle(sessionIds: readonly SessionId[]): Promise<number> {
    try {
      return await this.options.operations.run(sessionIds, this.effects.signal, async () => {
        const settlement = await runUntilAborted(this.effects.signal, () =>
          this.options.activity.observeParticipantActivities(
            this.options.workspaceKey,
            sessionIds,
            this.effects.signal,
          ),
        );
        if (settlement.kind !== "settled") return 0;
        const idle = snapshotIdleSessionIds(settlement.value, sessionIds);
        let terminalized = 0;
        for (const sessionId of idle) {
          if (this.effects.signal.aborted || this.options.lifecycle.status !== "ready") return 0;
          await terminalizeStoppedParticipant({
            scope: "blocking",
            requests: this.options.requests,
            notifications: this.options.notifications,
            fencingToken: this.options.lifecycle.fencingToken,
            workspaceKey: this.options.workspaceKey,
            stoppedSessionId: sessionId,
          });
          terminalized += 1;
        }
        return terminalized;
      });
    } catch (cause: unknown) {
      if (
        cause instanceof ParticipantOperationAbortedFault ||
        cause instanceof ParticipantOperationGateClosedFault
      )
        return 0;
      const code =
        cause instanceof ParticipantStopTerminalizationFault ? cause.code : "storage_failure";
      this.fail(code);
      throw new Error("Participant stop persistence failed closed.", { cause });
    }
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
      const raw: unknown = await this.options.requests.listParticipantStopCandidates({
        fencingToken: this.options.lifecycle.fencingToken,
        workspaceKey: this.options.workspaceKey,
      });
      const candidates = snapshotParticipantCandidates(raw);
      if (!candidates.ok) {
        this.fail(candidates.code);
        return;
      }
      for (
        let offset = 0;
        offset < candidates.sessionIds.length;
        offset += participantStopActivityBatchSize
      ) {
        if (this.effects.signal.aborted) return;
        await this.applyBatchIfIdle(
          candidates.sessionIds.slice(offset, offset + participantStopActivityBatchSize),
        );
      }
    } catch {
      if (!this.effects.signal.aborted) {
        this.fail("storage_failure");
      }
    }
  }

  private fail(code: ConstructorParameters<typeof RequestDeadlineSchedulerFault>[0]): void {
    const fault = new RequestDeadlineSchedulerFault(code);
    this.abortEffects(`participant_stop_${code}`);
    this.options.lifecycle.stop(code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
  }

  private abortEffects(reason: string): void {
    this.effects.abort(reason);
    if (this.timerArmed) {
      this.timerArmed = false;
      try {
        this.timers.clear(this.timerHandle);
      } catch {}
    }
  }
}
