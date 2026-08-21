import type { ActivityStatus, SessionId } from "../../domain/sessions";
import { validateSessionId } from "../../domain/sessions";

export interface NativeSession {
  readonly id: SessionId;
  readonly title: string;
  readonly updatedAtMs: number;
  readonly isArchived: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function data(value: unknown, label: string): unknown {
  if (!isRecord(value) || value.error !== undefined || !("data" in value)) {
    throw new Error(`${label} response envelope is malformed.`);
  }
  return value.data;
}

function nativeSession(value: unknown): NativeSession {
  if (!isRecord(value) || typeof value.title !== "string" || !isRecord(value.time)) {
    throw new Error("Native session entry is malformed.");
  }
  const id = validateSessionId(value.id);
  const updated = value.time.updated;
  const archived = value.time.archived;
  if (!id.ok || typeof updated !== "number" || !Number.isFinite(updated)) {
    throw new Error("Native session identity or update time is malformed.");
  }
  if (archived !== undefined && (typeof archived !== "number" || !Number.isFinite(archived))) {
    throw new Error("Native session archive time is malformed.");
  }
  return {
    id: id.value,
    title: value.title,
    updatedAtMs: updated,
    isArchived: archived !== undefined,
  };
}

export function parseSessionArray(value: unknown, label: string): NativeSession[] {
  if (!Array.isArray(value)) throw new Error(`${label} is malformed.`);
  return value.map(nativeSession);
}

export function parseV2SessionArray(value: unknown): NativeSession[] {
  const response = data(value, "V2 session listing");
  if (!isRecord(response)) throw new Error("V2 listing is malformed.");
  return parseSessionArray(response.data, "V2 listing data");
}

export function parseActiveMap(value: unknown): Record<string, unknown> {
  const response = data(value, "V2 active status");
  if (!isRecord(response) || !isRecord(response.data)) {
    throw new Error("V2 active status map is malformed.");
  }
  return response.data;
}

function activityStatus(value: unknown): ActivityStatus {
  if (!isRecord(value)) return "unknown";
  if (value.type === "busy" || value.type === "idle") return value.type;
  if (
    value.type === "retry" &&
    Number.isSafeInteger(value.attempt) &&
    (value.attempt as number) >= 0 &&
    typeof value.message === "string" &&
    typeof value.next === "number" &&
    Number.isFinite(value.next) &&
    value.next >= 0
  ) {
    return "retry";
  }
  return "unknown";
}

export function mergedActivityStatus(
  statuses: Readonly<Record<string, unknown>>,
  active: Readonly<Record<string, unknown>>,
  id: SessionId,
): ActivityStatus {
  const legacy = id in statuses ? activityStatus(statuses[id]) : "idle";
  if (legacy === "busy" || legacy === "retry") return legacy;
  if (!(id in active)) return legacy;
  const activeEntry = active[id];
  return isRecord(activeEntry) && activeEntry.type === "running" ? "busy" : "unknown";
}

export function combineRootSets(
  visibleRoots: readonly NativeSession[],
  archivedRoots: readonly NativeSession[],
): NativeSession[] {
  const rootsById = new Map<SessionId, NativeSession>();
  for (const root of visibleRoots) rootsById.set(root.id, { ...root, isArchived: false });
  for (const archived of archivedRoots) {
    // Membership in archived=true is the authoritative archive evidence.
    rootsById.set(archived.id, { ...archived, isArchived: true });
  }
  return [...rootsById.values()];
}
