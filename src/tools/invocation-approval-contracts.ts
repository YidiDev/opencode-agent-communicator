import type { OperationControl } from "../application/delivery-ports";
import { snapshotDataRecord } from "../application/strict-port-boundaries";
import type { Sha256Digest } from "../domain/message-payload";

export function exactApprovalRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const record = snapshotDataRecord(value, keys.length);
  if (!record) return undefined;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? record
    : undefined;
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function hasExactApprovalControl(
  value: unknown,
  expectedAbort: AbortSignal,
  expectedDeadlineMs: number | undefined,
): value is OperationControl {
  const keys = expectedDeadlineMs === undefined ? ["abort"] : ["abort", "deadlineMs"];
  const control = exactApprovalRecord(value, keys);
  return (
    control !== undefined &&
    control.abort === expectedAbort &&
    control.deadlineMs === expectedDeadlineMs &&
    (expectedDeadlineMs === undefined ||
      (Number.isSafeInteger(expectedDeadlineMs) && expectedDeadlineMs >= 0))
  );
}
