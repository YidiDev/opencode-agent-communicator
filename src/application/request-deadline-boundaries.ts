import type { NextPendingRequestDeadline } from "./request-ports";
import { snapshotDataRecord } from "./strict-port-boundaries";

export function inspectPendingDeadlineSchedule(
  value: unknown,
): NextPendingRequestDeadline | undefined {
  const row = snapshotDataRecord(value, 3);
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
}
