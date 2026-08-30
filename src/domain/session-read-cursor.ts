import type { Sha256Digest } from "./message-payload";
import { sessionReadLimits, sessionReadProjectionVersion } from "./session-read";
import { type SessionId, validateSessionId } from "./sessions";

export interface SessionReadCursorBoundary {
  readonly messageId: string;
  readonly itemKey: string;
  readonly utf8ByteOffset: number;
  readonly prefixSha256: Sha256Digest;
}

export type SessionReadCursorValidation =
  | { readonly ok: true; readonly boundary: SessionReadCursorBoundary }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "workspace_mismatch" | "session_mismatch" | "version_mismatch";
      readonly message: string;
    };

type CursorFailureReason = Exclude<SessionReadCursorValidation, { readonly ok: true }>["reason"];

function invalid(reason: CursorFailureReason): SessionReadCursorValidation {
  return { ok: false, reason, message: "cursor is malformed or does not match this session read." };
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCursorToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= sessionReadLimits.maxCursorCharacters &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function encodeSessionReadCursor(
  workspaceBindingSha256: Sha256Digest,
  sessionId: SessionId,
  boundary: SessionReadCursorBoundary,
): string {
  if (
    !isDigest(workspaceBindingSha256) ||
    !validateSessionId(sessionId).ok ||
    !isCursorToken(boundary.messageId) ||
    !isCursorToken(boundary.itemKey) ||
    !Number.isSafeInteger(boundary.utf8ByteOffset) ||
    boundary.utf8ByteOffset < 0 ||
    !isDigest(boundary.prefixSha256)
  ) {
    throw new TypeError("Session read cursor boundary is invalid.");
  }
  const encoded = encodeBase64Url(
    JSON.stringify({
      v: sessionReadProjectionVersion,
      w: workspaceBindingSha256,
      s: sessionId,
      m: boundary.messageId,
      k: boundary.itemKey,
      o: boundary.utf8ByteOffset,
      p: boundary.prefixSha256,
    }),
  );
  if (encoded.length > sessionReadLimits.maxCursorCharacters) {
    throw new TypeError("Session read cursor exceeds its immutable size limit.");
  }
  return encoded;
}

export function decodeSessionReadCursor(
  cursor: unknown,
  expectedWorkspaceBindingSha256: Sha256Digest,
  expectedSessionId: SessionId,
): SessionReadCursorValidation {
  if (
    typeof cursor !== "string" ||
    cursor.length < 1 ||
    cursor.length > sessionReadLimits.maxCursorCharacters ||
    !/^[A-Za-z0-9_-]+$/.test(cursor) ||
    !isDigest(expectedWorkspaceBindingSha256) ||
    !validateSessionId(expectedSessionId).ok
  )
    return invalid("malformed");

  try {
    const standard = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const value: unknown = JSON.parse(
      atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`),
    );
    if (!isRecord(value)) return invalid("malformed");
    if (Object.keys(value).join(",") !== "v,w,s,m,k,o,p") return invalid("malformed");
    if (value.v !== sessionReadProjectionVersion) return invalid("version_mismatch");
    if (value.w !== expectedWorkspaceBindingSha256) return invalid("workspace_mismatch");
    if (value.s !== expectedSessionId) return invalid("session_mismatch");
    if (
      !isCursorToken(value.m) ||
      !isCursorToken(value.k) ||
      !Number.isSafeInteger(value.o) ||
      typeof value.o !== "number" ||
      value.o < 0 ||
      !isDigest(value.p)
    )
      return invalid("malformed");
    const boundary = {
      messageId: value.m,
      itemKey: value.k,
      utf8ByteOffset: value.o,
      prefixSha256: value.p,
    };
    return encodeSessionReadCursor(expectedWorkspaceBindingSha256, expectedSessionId, boundary) ===
      cursor
      ? { ok: true, boundary }
      : invalid("malformed");
  } catch {
    return invalid("malformed");
  }
}
