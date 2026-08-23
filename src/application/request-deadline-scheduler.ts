import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import type { WorkspaceKey } from "../domain/workspaces";
import { observeNativePromiseRejection } from "./native-promise-observation";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type {
  NextPendingRequestDeadline,
  RequestDeadlinePersistencePort,
  RequestStoreFailureCode,
} from "./request-ports";
import { requestStoreFailureCodes } from "./request-ports";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";

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
  readonly onFault?: (fault: RequestDeadlineSchedulerFault) => undefined;
}

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

const requestDeadlineMaximumMetadataKeys = 27;

function defaultMonotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function dataRecord(value: unknown, maximumKeys: number): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function denseArray(value: unknown, maximumLength: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumLength + 1) return undefined;
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const rawLength: unknown = lengthDescriptor?.value;
  if (
    typeof rawLength !== "number" ||
    !Number.isSafeInteger(rawLength) ||
    rawLength < 0 ||
    rawLength > maximumLength
  ) {
    return undefined;
  }
  const length = rawLength;
  if (
    keys.length !== length + 1 ||
    keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))
  ) {
    return undefined;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function inspectSchedule(value: unknown): NextPendingRequestDeadline | undefined {
  try {
    const row = dataRecord(value, 3);
    if (!row) return undefined;
    const keys = Object.keys(row);
    if (
      keys.length < 2 ||
      keys.length > 3 ||
      !keys.includes("storeObservedAtMs") ||
      !keys.includes("maximumSleepMs") ||
      !keys.every((key) =>
        ["storeObservedAtMs", "maximumSleepMs", "nextDeadlineAtMs"].includes(key),
      ) ||
      !Number.isSafeInteger(row.storeObservedAtMs) ||
      (row.storeObservedAtMs as number) < 0 ||
      !Number.isSafeInteger(row.maximumSleepMs) ||
      (row.maximumSleepMs as number) < 1
    ) {
      return undefined;
    }
    if (
      Object.hasOwn(row, "nextDeadlineAtMs") &&
      (!Number.isSafeInteger(row.nextDeadlineAtMs) || (row.nextDeadlineAtMs as number) < 0)
    ) {
      return undefined;
    }
    return Object.freeze({
      storeObservedAtMs: row.storeObservedAtMs as number,
      maximumSleepMs: row.maximumSleepMs as number,
      ...(Object.hasOwn(row, "nextDeadlineAtMs")
        ? { nextDeadlineAtMs: row.nextDeadlineAtMs as number }
        : {}),
    });
  } catch {
    return undefined;
  }
}

function classifyFailure(code: RequestStoreFailureCode): RequestDeadlineSchedulerFaultCode {
  return code === "ownership_lost" ? "ownership_lost" : "storage_failure";
}

/** A serialized, bounded, single-timer scheduler; every expiry decision is delegated to the store. */
export class RequestDeadlineScheduler {
  private readonly timers: RequestDeadlineTimerPort;
  private readonly nowMonotonicMs: () => number;
  private readonly stopLatch: Promise<void>;
  private releaseStopLatch!: () => void;
  private active = false;
  private stopped = false;
  private faultReported = false;
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

  wake(): void {
    if (!this.active) return;
    this.dirty = true;
    if (!this.clearTimer()) return;
    if (this.pumping) return;
    this.pumping = true;
    this.completion = Promise.resolve().then(() => this.pump());
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active = false;
    this.dirty = false;
    this.releaseStopLatch();
    if (!this.clearTimerHandle()) this.reportFault("port_contract_violation");
  }

  /** Deterministic test hook. A stop releases it even if an adapter Promise never settles. */
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
    return this.readSchedule();
  }

  private async expireBatch(budget: PumpBudget): Promise<BatchDecision> {
    let returned: unknown;
    try {
      returned = await this.options.requests.expireDueRequests({
        fencingToken: this.options.fencingToken,
        workspaceKey: this.options.workspaceKey,
        limit: requestDeadlineBatchLimit,
      });
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
      returned = await this.options.requests.readNextPendingDeadline({
        fencingToken: this.options.fencingToken,
        workspaceKey: this.options.workspaceKey,
      });
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
    const schedule = inspectSchedule(returned);
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
      const result = dataRecord(value, 2);
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
      const rawRequests = denseArray(result.requests, requestDeadlineBatchLimit);
      if (!rawRequests) throw new TypeError();
      if (budget.expiredRows + rawRequests.length > requestDeadlineMaximumExpiredRowsPerPump) {
        throw new TypeError();
      }
      const requests: RequestMetadata[] = [];
      for (const raw of rawRequests) {
        const request = dataRecord(raw, requestDeadlineMaximumMetadataKeys);
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
    return true;
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
    this.releaseStopLatch();
    this.timerVersion += 1;
    this.clearTimerHandle();
    this.reportFault(code);
  }

  private reportFault(code: RequestDeadlineSchedulerFaultCode): void {
    if (this.faultReported) return;
    this.faultReported = true;
    const callback = this.options.onFault;
    if (!callback) return;
    try {
      const returned: unknown = callback(new RequestDeadlineSchedulerFault(code));
      if (returned !== undefined) observeNativePromiseRejection(returned);
    } catch {
      // Fault reporting cannot revive or reject the stopped scheduler pump.
    }
  }
}
