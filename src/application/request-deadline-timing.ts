import type { RequestDeadlineTimedSchedule } from "./request-deadline-pump";
import type { RequestDeadlineTimerPort } from "./request-deadline-scheduler-contracts";

export const requestDeadlineMaximumTimerDelayMs = 2_147_483_647;

export const nativeDeadlineTimers: RequestDeadlineTimerPort = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function defaultMonotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function remainingStoreDelay(
  storeObservedAtMs: number,
  maximumSleepMs: number,
  nextAtMs: number | undefined,
  elapsedMs: number,
): number | "immediate" {
  let delay = Math.min(maximumSleepMs, requestDeadlineMaximumTimerDelayMs);
  if (nextAtMs !== undefined) {
    if (nextAtMs <= storeObservedAtMs + elapsedMs) return "immediate";
    delay = Math.min(delay, nextAtMs - storeObservedAtMs);
  }
  return delay - Math.ceil(elapsedMs);
}

export function calculateRequestDeadlineScheduleDelay(
  timed: RequestDeadlineTimedSchedule,
): number | "immediate" | "invalid" {
  const { schedule, elapsedMs } = timed;
  let delay = remainingStoreDelay(
    schedule.storeObservedAtMs,
    schedule.maximumSleepMs,
    schedule.nextDeadlineAtMs,
    elapsedMs,
  );
  if (delay === "immediate") return delay;
  if (timed.lockSchedule) {
    if (timed.lockElapsedMs === undefined) return "invalid";
    const lockDelay = remainingStoreDelay(
      timed.lockSchedule.storeObservedAtMs,
      timed.lockSchedule.maximumSleepMs,
      timed.lockSchedule.nextExpiryAtMs,
      timed.lockElapsedMs,
    );
    if (lockDelay === "immediate") return lockDelay;
    delay = Math.min(delay, lockDelay);
  }
  if (delay <= 0) return "immediate";
  if (!Number.isSafeInteger(delay) || delay < 1) return "invalid";
  return delay;
}
