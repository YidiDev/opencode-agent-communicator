import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { observeNativePromiseRejection } from "./native-promise-observation";
import { inspectPendingDeadlineSchedule } from "./request-deadline-boundaries";
import { drainRequestMaintenance, type RequestMaintenancePorts } from "./request-maintenance";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type {
  NextPendingRequestDeadline,
  RequestDeadlinePersistencePort,
  RequestStoreFailureCode,
} from "./request-ports";
import { requestStoreFailureCodes } from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export const requestDeadlineBatchLimit = 100;
export const requestDeadlineMaximumTimerDelayMs = 2_147_483_647;
export const requestDeadlineMaximumExpiredRowsPerPump = 2_048;
export const requestDeadlineMaximumBatchesPerPump = 22;
export const requestDeadlineMaximumImmediateSchedulesPerPump = 32;

export interface RequestDeadlineTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const nativeDeadlineTimers: RequestDeadlineTimerPort = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type RequestDeadlineSchedulerFaultCode =
  | "ownership_lost"
  | "storage_failure"
  | "port_contract_violation";

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
  readonly onFault?: (fault: RequestDeadlineSchedulerFault) => undefined;
}

export type RequestDeadlineSchedulerStatus = "idle" | "starting" | "ready" | "stopped" | "faulted";
export type RequestDeadlineSchedulerReadiness =
  | Readonly<{ readonly ok: true }>
  | Readonly<{ readonly ok: false; readonly fault: RequestDeadlineSchedulerFault }>;

interface PumpBudget {
  readonly seen: Set<string>;
  expiredRows: number;
  batches: number;
  immediateSchedules: number;
}

type ScheduleDecision = "armed" | "immediate" | "failed";
type BatchDecision = "full" | "done" | "stopped";
type TimedSchedule = Readonly<{
  schedule: NextPendingRequestDeadline;
  elapsedMs: number;
}>;

function defaultMonotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function classifyFailure(code: RequestStoreFailureCode): RequestDeadlineSchedulerFaultCode {
  return code === "ownership_lost" ? "ownership_lost" : "storage_failure";
}

export class RequestDeadlineScheduler {
  private readonly timers: RequestDeadlineTimerPort;
  private readonly nowMonotonicMs: () => number;
  private readonly stopLatch: Promise<void>;
  private readonly effectController = new AbortController();
  private releaseStopLatch!: () => void;
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
    this.stopLatch = new Promise((resolve) => {
      this.releaseStopLatch = resolve;
    });
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
    this.effectController.abort("scheduler_stopped");
    this.releaseStopLatch();
    const stoppedFault = new RequestDeadlineSchedulerFault("port_contract_violation");
    this.resolveReadiness(Object.freeze({ ok: false, fault: stoppedFault }));
    if (!this.clearTimerHandle()) {
      this.faultValue = stoppedFault;
      this.reportFault(stoppedFault);
    }
  }

  async drain(): Promise<void> {
    while (!this.stopped) {
      const observed = this.completion;
      await Promise.race([observed, this.stopLatch]);
      if (this.stopped) return;
      if (observed === this.completion) return;
    }
  }

  private async pump(): Promise<void> {
    const budget: PumpBudget = {
      seen: new Set(),
      expiredRows: 0,
      batches: 0,
      immediateSchedules: 0,
    };
    try {
      while (this.active && this.dirty) {
        this.dirty = false;
        const timedSchedule = await this.expireAndRead(budget);
        if (!this.active || !timedSchedule) return;
        if (!this.applySchedule(timedSchedule, budget)) return;
      }
    } catch (cause: unknown) {
      this.fail(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_failure");
    } finally {
      this.pumping = false;
      if (this.active && this.dirty) this.wake();
    }
  }

  private async expireAndRead(budget: PumpBudget): Promise<TimedSchedule | undefined> {
    while (this.active) {
      budget.batches += 1;
      if (budget.batches > requestDeadlineMaximumBatchesPerPump) {
        this.fail("port_contract_violation");
        return undefined;
      }
      const decision = await this.expireBatch(budget);
      if (decision === "stopped") return undefined;
      if (decision === "done") break;
    }
    if (!(await this.runMaintenance())) return undefined;
    return this.readSchedule();
  }

  private async runMaintenance(): Promise<boolean> {
    if (!this.options.maintenance) return this.active;
    const result = await drainRequestMaintenance({
      ports: this.options.maintenance,
      fencingToken: this.options.fencingToken,
      workspaceKey: this.options.workspaceKey,
      shouldStop: () => !this.active,
      abort: this.effectController.signal,
    });
    if (!this.active) return false;
    if (result.ok) return true;
    this.fail(
      result.code === "ownership_lost"
        ? "ownership_lost"
        : result.code === "contract"
          ? "port_contract_violation"
          : "storage_failure",
    );
    return false;
  }

  private async expireBatch(budget: PumpBudget): Promise<BatchDecision> {
    let returned: unknown;
    try {
      const settlement = await runUntilAborted(this.effectController.signal, () =>
        this.options.requests.expireDueRequests({
          fencingToken: this.options.fencingToken,
          workspaceKey: this.options.workspaceKey,
          limit: requestDeadlineBatchLimit,
        }),
      );
      if (settlement.kind === "aborted") return "stopped";
      if (settlement.kind === "rejected") throw settlement.cause;
      returned = settlement.value;
    } catch (cause: unknown) {
      this.fail(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_failure");
      return "stopped";
    }
    if (!this.active) return "stopped";
    const inspected = this.inspectExpiration(returned, budget);
    if (!inspected) return "stopped";
    if ("failure" in inspected) {
      this.fail(inspected.failure);
      return "stopped";
    }
    for (const request of inspected.requests) {
      try {
        notifyTerminalSafely(
          this.options.notifications,
          createTerminalNotificationEvent(request as never),
        );
      } catch {
        this.fail("port_contract_violation");
        return "stopped";
      }
    }
    return inspected.requests.length === requestDeadlineBatchLimit ? "full" : "done";
  }

  private async readSchedule(): Promise<TimedSchedule | undefined> {
    if (!this.active) return undefined;
    const before = this.readMonotonicClock();
    if (before === undefined) return undefined;
    let returned: unknown;
    try {
      const settlement = await runUntilAborted(this.effectController.signal, () =>
        this.options.requests.readNextPendingDeadline({
          fencingToken: this.options.fencingToken,
          workspaceKey: this.options.workspaceKey,
        }),
      );
      if (settlement.kind === "aborted") return undefined;
      if (settlement.kind === "rejected") throw settlement.cause;
      returned = settlement.value;
    } catch (cause: unknown) {
      this.fail(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_failure");
      return undefined;
    }
    if (!this.active) return undefined;
    const after = this.readMonotonicClock();
    if (after === undefined) return undefined;
    if (after < before) {
      this.fail("port_contract_violation");
      return undefined;
    }
    const schedule = inspectPendingDeadlineSchedule(returned);
    if (schedule) return { schedule, elapsedMs: after - before };
    this.fail("port_contract_violation");
    return undefined;
  }

  private inspectExpiration(
    value: unknown,
    budget: PumpBudget,
  ):
    | { readonly requests: readonly RequestMetadata[] }
    | { readonly failure: RequestDeadlineSchedulerFaultCode }
    | undefined {
    try {
      const result = snapshotDataRecord(value, 2);
      if (!result) throw new TypeError();
      const keys = Object.keys(result);
      if (result.ok === false) {
        if (
          keys.length !== 2 ||
          !keys.includes("code") ||
          !requestStoreFailureCodes.includes(result.code as RequestStoreFailureCode)
        ) {
          throw new TypeError();
        }
        return { failure: classifyFailure(result.code as RequestStoreFailureCode) };
      }
      if (result.ok !== true || keys.length !== 2 || !keys.includes("requests")) {
        throw new TypeError();
      }
      const rawRequests = snapshotDenseArray(result.requests, requestDeadlineBatchLimit);
      if (!rawRequests) throw new TypeError();
      if (budget.expiredRows + rawRequests.length > requestDeadlineMaximumExpiredRowsPerPump) {
        throw new TypeError();
      }
      const requests: RequestMetadata[] = [];
      for (const raw of rawRequests) {
        const request = inspectRequestMetadata(raw);
        if (
          !request ||
          !isCoherentRequestMetadata(request) ||
          request.workspaceKey !== this.options.workspaceKey ||
          request.resolutionState !== "deadline_expired" ||
          budget.seen.has(request.id as string)
        ) {
          throw new TypeError();
        }
        budget.seen.add(request.id as string);
        requests.push(Object.freeze(request) as unknown as RequestMetadata);
      }
      budget.expiredRows += requests.length;
      return { requests };
    } catch {
      this.fail("port_contract_violation");
      return undefined;
    }
  }

  private arm({ schedule, elapsedMs }: TimedSchedule): ScheduleDecision {
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

  private applySchedule(schedule: TimedSchedule, budget: PumpBudget): boolean {
    if (this.dirty) return true;
    const decision = this.arm(schedule);
    if (decision === "failed") return false;
    if (decision === "immediate") {
      budget.immediateSchedules += 1;
      if (budget.immediateSchedules > requestDeadlineMaximumImmediateSchedulesPerPump) {
        this.fail("port_contract_violation");
        return false;
      }
      this.dirty = true;
      return true;
    }
    if (this.dirty) return this.clearTimer();
    if (this.timerArmed) this.markReady();
    return true;
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
    this.releaseStopLatch();
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
