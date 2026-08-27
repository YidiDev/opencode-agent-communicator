import type { FencingToken } from "../domain/ownership";
import type { WorkspaceKey } from "../domain/workspaces";
import type { DeliveryRetentionPersistencePort } from "./delivery-retention";
import { observeNativePromiseRejection } from "./native-promise-observation";
import type { RequestDeadlinePumpFaultCode } from "./request-deadline-maintenance";
import { type RequestDeadlineTimedSchedule, runRequestDeadlinePump } from "./request-deadline-pump";
import type { RequestMaintenancePorts } from "./request-maintenance";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type { RequestDeadlinePersistencePort } from "./request-ports";

export {
  requestDeadlineBatchLimit,
  requestDeadlineMaximumExpiredRowsPerPump,
} from "./request-deadline-inspection";
export { requestDeadlineMaximumBatchesPerPump } from "./request-deadline-pump";

export const requestDeadlineMaximumTimerDelayMs = 2_147_483_647;
export const requestDeadlineMaximumImmediateSchedulesPerPump = 32;

export interface RequestDeadlineTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const nativeDeadlineTimers: RequestDeadlineTimerPort = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type RequestDeadlineSchedulerFaultCode = RequestDeadlinePumpFaultCode;

export class RequestDeadlineSchedulerFault extends Error {
  override readonly name = "RequestDeadlineSchedulerFault";

  constructor(readonly code: RequestDeadlineSchedulerFaultCode) {
    super(`Request deadline scheduler stopped: ${code}.`);
  }
}

export interface RequestDeadlineSchedulerOptions {
  readonly requests: RequestDeadlinePersistencePort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly timers?: RequestDeadlineTimerPort;
  readonly nowMonotonicMs?: () => number;
  readonly maintenance?: RequestMaintenancePorts;
  readonly additionalMaintenance?: (
    shouldStop: () => boolean,
    abort: AbortSignal,
  ) => Promise<{ readonly ok: boolean; readonly code?: string }>;
  readonly deliveryRetention?: DeliveryRetentionPersistencePort;
  readonly onFault?: (fault: RequestDeadlineSchedulerFault) => undefined;
}

export type RequestDeadlineSchedulerStatus = "idle" | "starting" | "ready" | "stopped" | "faulted";
export type RequestDeadlineSchedulerReadiness =
  | Readonly<{ readonly ok: true }>
  | Readonly<{ readonly ok: false; readonly fault: RequestDeadlineSchedulerFault }>;

type ScheduleDecision = "armed" | "immediate" | "failed";

function defaultMonotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export class RequestDeadlineScheduler {
  private readonly timers: RequestDeadlineTimerPort;
  private readonly nowMonotonicMs: () => number;
  private readonly effectController = new AbortController();
  private active = false;
  private stopped = false;
  private faultReported = false;
  private ready = false;
  private faultValue: RequestDeadlineSchedulerFault | undefined;
  private readonly readinessWaiters: Array<(value: RequestDeadlineSchedulerReadiness) => void> = [];
  private dirty = false;
  private pumping = false;
  private timerHandle: unknown;
  private timerArmed = false;
  private timerVersion = 0;
  private completion: Promise<void> = Promise.resolve();

  constructor(private readonly options: RequestDeadlineSchedulerOptions) {
    this.timers = options.timers ?? nativeDeadlineTimers;
    this.nowMonotonicMs = options.nowMonotonicMs ?? defaultMonotonicNowMs;
  }

  start(): void {
    if (this.active || this.stopped) return;
    this.active = true;
    this.wake();
  }

  startAndWaitReady(): Promise<RequestDeadlineSchedulerReadiness> {
    if (this.faultValue) {
      return Promise.resolve(Object.freeze({ ok: false, fault: this.faultValue }));
    }
    if (this.stopped) {
      return Promise.resolve(
        Object.freeze({
          ok: false,
          fault: new RequestDeadlineSchedulerFault("port_contract_violation"),
        }),
      );
    }
    if (this.ready) return Promise.resolve(Object.freeze({ ok: true }));
    const readiness = new Promise<RequestDeadlineSchedulerReadiness>((resolve) => {
      this.readinessWaiters.push(resolve);
    });
    this.start();
    return readiness;
  }

  get status(): RequestDeadlineSchedulerStatus {
    if (this.faultValue) return "faulted";
    if (this.stopped) return "stopped";
    if (this.ready) return "ready";
    return this.active ? "starting" : "idle";
  }

  get fault(): RequestDeadlineSchedulerFault | undefined {
    return this.faultValue;
  }

  wake(): undefined {
    if (!this.active) return undefined;
    this.dirty = true;
    if (!this.clearTimer()) return undefined;
    if (this.pumping) return undefined;
    this.pumping = true;
    this.completion = Promise.resolve().then(() => this.pump());
    return undefined;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active = false;
    this.dirty = false;
    // Interrupt bounded port wrappers before disposal starts waiting for the pump. The pump
    // promise remains the drain boundary, while a non-cooperative promise that lost the abort
    // race stays observed by the wrapper and cannot make disposal unbounded.
    this.effectController.abort("scheduler_stopped");
    const stoppedFault = new RequestDeadlineSchedulerFault("port_contract_violation");
    this.resolveReadiness(Object.freeze({ ok: false, fault: stoppedFault }));
    if (!this.clearTimerHandle()) {
      this.faultValue = stoppedFault;
      this.reportFault(stoppedFault);
    }
  }

  async drain(): Promise<void> {
    for (;;) {
      const observed = this.completion;
      await observed;
      // A completing pump may synchronously schedule its replacement from `finally`. Do not
      // release disposal until the replacement has also settled, including after stop.
      if (observed === this.completion && !this.pumping) return;
    }
  }

  private async pump(): Promise<void> {
    let immediateSchedules = 0;
    try {
      await runRequestDeadlinePump({
        options: this.options,
        abort: this.effectController.signal,
        isActive: () => this.active,
        consumeDirty: () => {
          if (!this.dirty) return false;
          this.dirty = false;
          return true;
        },
        readMonotonicMs: () => this.readMonotonicClock(),
        applySchedule: (schedule) => {
          const result = this.applySchedule(schedule, immediateSchedules);
          immediateSchedules = result.immediateSchedules;
          return result.continue;
        },
        fail: (code) => this.fail(code),
      });
    } finally {
      this.pumping = false;
      if (this.active && this.dirty) this.wake();
    }
  }

  private arm({ schedule, elapsedMs }: RequestDeadlineTimedSchedule): ScheduleDecision {
    let delay = Math.min(schedule.maximumSleepMs, requestDeadlineMaximumTimerDelayMs);
    if (schedule.nextDeadlineAtMs !== undefined) {
      if (schedule.nextDeadlineAtMs <= schedule.storeObservedAtMs + elapsedMs) return "immediate";
      delay = Math.min(delay, schedule.nextDeadlineAtMs - schedule.storeObservedAtMs);
    }
    delay -= Math.ceil(elapsedMs);
    if (delay <= 0) return "immediate";
    if (!Number.isSafeInteger(delay) || delay < 1) {
      this.fail("port_contract_violation");
      return "failed";
    }
    const version = ++this.timerVersion;
    let handle: unknown;
    try {
      handle = this.timers.set(delay, () => {
        if (!this.active || version !== this.timerVersion) return;
        this.timerHandle = undefined;
        this.timerArmed = false;
        this.wake();
      });
    } catch {
      this.fail("port_contract_violation");
      return "failed";
    }
    if (!this.active || version !== this.timerVersion || this.dirty) {
      try {
        this.timers.clear(handle);
      } catch {
        this.fail("port_contract_violation");
        return "failed";
      }
      return this.active ? "armed" : "failed";
    }
    this.timerHandle = handle;
    this.timerArmed = true;
    return "armed";
  }

  private applySchedule(
    schedule: RequestDeadlineTimedSchedule,
    immediateSchedules: number,
  ): { readonly continue: boolean; readonly immediateSchedules: number } {
    if (this.dirty) return { continue: true, immediateSchedules };
    const decision = this.arm(schedule);
    if (decision === "failed") return { continue: false, immediateSchedules };
    if (decision === "immediate") {
      const nextImmediateSchedules = immediateSchedules + 1;
      if (nextImmediateSchedules > requestDeadlineMaximumImmediateSchedulesPerPump) {
        this.fail("port_contract_violation");
        return { continue: false, immediateSchedules: nextImmediateSchedules };
      }
      this.dirty = true;
      return { continue: true, immediateSchedules: nextImmediateSchedules };
    }
    if (this.dirty) {
      return { continue: this.clearTimer(), immediateSchedules };
    }
    if (this.timerArmed) this.markReady();
    return { continue: true, immediateSchedules };
  }

  private markReady(): void {
    if (this.ready || this.stopped) return;
    this.ready = true;
    this.resolveReadiness(Object.freeze({ ok: true }));
  }

  private resolveReadiness(value: RequestDeadlineSchedulerReadiness): void {
    const waiters = this.readinessWaiters.splice(0);
    for (const resolve of waiters) resolve(value);
  }

  private clearTimer(): boolean {
    this.timerVersion += 1;
    if (this.clearTimerHandle()) return true;
    this.fail("port_contract_violation");
    return false;
  }

  private clearTimerHandle(): boolean {
    if (!this.timerArmed) return true;
    const handle = this.timerHandle;
    this.timerHandle = undefined;
    this.timerArmed = false;
    try {
      this.timers.clear(handle);
      return true;
    } catch {
      return false;
    }
  }

  private readMonotonicClock(): number | undefined {
    let reading: unknown;
    try {
      reading = this.nowMonotonicMs();
    } catch {
      this.fail("port_contract_violation");
      return undefined;
    }
    if (typeof reading !== "number" || !Number.isFinite(reading) || reading < 0) {
      this.fail("port_contract_violation");
      return undefined;
    }
    return reading;
  }

  private fail(code: RequestDeadlineSchedulerFaultCode): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active = false;
    this.dirty = false;
    this.effectController.abort("scheduler_faulted");
    this.timerVersion += 1;
    this.clearTimerHandle();
    const fault = new RequestDeadlineSchedulerFault(code);
    this.faultValue = fault;
    this.resolveReadiness(Object.freeze({ ok: false, fault }));
    this.reportFault(fault);
  }

  private reportFault(fault: RequestDeadlineSchedulerFault): void {
    if (this.faultReported) return;
    this.faultReported = true;
    const callback = this.options.onFault;
    if (!callback) return;
    try {
      const returned: unknown = callback(fault);
      if (returned !== undefined) observeNativePromiseRejection(returned);
    } catch {}
  }
}
