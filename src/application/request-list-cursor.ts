import { type RequestId, validateRequestId } from "../domain/generated-ids";
import type { RequestListRole } from "../domain/request-types";

export interface RequestListBoundary {
  readonly createdAtMs: number;
  readonly requestId: RequestId;
}

const cursorVersion = 1;
const roles: readonly RequestListRole[] = ["inbox", "outbox", "all"];

export type RequestCursorValidation =
  | { readonly ok: true; readonly boundary: RequestListBoundary }
  | { readonly ok: false; readonly message: string };

function invalid(): RequestCursorValidation {
  return { ok: false, message: "cursor is malformed or does not match the requested role." };
}

export function encodeRequestListCursor(
  role: RequestListRole,
  boundary: RequestListBoundary,
): string {
  if (
    !roles.includes(role) ||
    !Number.isSafeInteger(boundary.createdAtMs) ||
    boundary.createdAtMs < 0
  ) {
    throw new TypeError("Request cursor boundary is invalid.");
  }
  const requestId = validateRequestId(boundary.requestId);
  if (!requestId.ok) throw new TypeError("Request cursor boundary is invalid.");
  return btoa(
    JSON.stringify({
      v: cursorVersion,
      role,
      createdAtMs: boundary.createdAtMs,
      requestId: requestId.value,
    }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function parseRequestListCursor(
  cursor: unknown,
  expectedRole: RequestListRole,
): RequestCursorValidation {
  if (
    typeof cursor !== "string" ||
    cursor.length < 1 ||
    cursor.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    return invalid();
  }
  try {
    const standard = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const text = atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).join(",") !== "v,role,createdAtMs,requestId" ||
      record.v !== cursorVersion ||
      record.role !== expectedRole ||
      !Number.isSafeInteger(record.createdAtMs) ||
      (record.createdAtMs as number) < 0
    )
      return invalid();
    const requestId = validateRequestId(record.requestId);
    if (!requestId.ok) return invalid();
    const boundary = { createdAtMs: record.createdAtMs as number, requestId: requestId.value };
    return encodeRequestListCursor(expectedRole, boundary) === cursor
      ? { ok: true, boundary }
      : invalid();
  } catch {
    return invalid();
  }
}
