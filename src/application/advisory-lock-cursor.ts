import { validateAdvisoryLockId } from "../domain/generated-ids";
import type { AdvisoryLockCursor } from "./advisory-lock-contracts";

const maximumCursorCharacters = 256;

export function encodeAdvisoryLockCursor(cursor: AdvisoryLockCursor): string {
  if (
    !Number.isSafeInteger(cursor.createdAtMs) ||
    cursor.createdAtMs < 0 ||
    !validateAdvisoryLockId(cursor.lockId).ok
  ) {
    throw new TypeError("Advisory lock cursor is malformed.");
  }
  return Buffer.from(
    JSON.stringify({ v: 1, c: cursor.createdAtMs, l: cursor.lockId }),
    "utf8",
  ).toString("base64url");
}

export function decodeAdvisoryLockCursor(value: unknown): AdvisoryLockCursor | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumCursorCharacters ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "c,l,v" ||
      record.v !== 1 ||
      !Number.isSafeInteger(record.c) ||
      (record.c as number) < 0
    ) {
      return undefined;
    }
    const lockId = validateAdvisoryLockId(record.l);
    if (!lockId.ok) return undefined;
    const cursor = { createdAtMs: record.c as number, lockId: lockId.value };
    return encodeAdvisoryLockCursor(cursor) === value ? Object.freeze(cursor) : undefined;
  } catch {
    return undefined;
  }
}
