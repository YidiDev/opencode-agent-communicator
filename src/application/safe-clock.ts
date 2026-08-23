import type { ClockPort } from "./delivery-ports";

/** Reads an untrusted wall clock without allowing throws or invalid values to bypass a deadline. */
export function readSafeClockMs(clock: ClockPort): number | undefined {
  try {
    const value: unknown = clock.nowMs();
    return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
  } catch {
    return undefined;
  }
}

export function operationControlStopped(
  clock: ClockPort,
  abort: AbortSignal,
  deadlineMs: number | undefined,
): boolean {
  if (abort.aborted) return true;
  if (deadlineMs === undefined) return false;
  const now = readSafeClockMs(clock);
  return now === undefined || now >= deadlineMs;
}
