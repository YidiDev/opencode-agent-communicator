import type { ActivityStatus, SessionId } from "../../domain/sessions";
import { validateSessionId } from "../../domain/sessions";

export interface NativeSession {
  readonly id: SessionId;
  readonly title: string;
  readonly updatedAtMs: number;
  readonly isArchived: boolean;
}

const nativeSessionListHardCeiling = 1_000;

function snapshotDictionary(
  value: unknown,
  maximumKeys = 10_000,
): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

export function snapshotEnvelopeData(value: unknown, label: string): unknown {
  const envelope = snapshotDictionary(value, 8);
  if (!envelope || envelope.error !== undefined || !Object.hasOwn(envelope, "data")) {
    throw new Error(`${label} response envelope is malformed.`);
  }
  return envelope.data;
}

function nativeSession(value: unknown): NativeSession {
  const session = snapshotDictionary(value, 32);
  const time = session && snapshotDictionary(session.time, 8);
  if (!session || typeof session.title !== "string" || !time) {
    throw new Error("Native session entry is malformed.");
  }
  const id = validateSessionId(session.id);
  const updated = time.updated;
  const archived = time.archived;
  if (!id.ok || typeof updated !== "number" || !Number.isFinite(updated)) {
    throw new Error("Native session identity or update time is malformed.");
  }
  if (archived !== undefined && (typeof archived !== "number" || !Number.isFinite(archived))) {
    throw new Error("Native session archive time is malformed.");
  }
  return {
    id: id.value,
    title: session.title,
    updatedAtMs: updated,
    isArchived: archived !== undefined,
  };
}

export function parseSessionArray(value: unknown, label: string): NativeSession[] {
  let length: number;
  let keys: readonly PropertyKey[];
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`${label} is malformed.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    length = descriptor?.value;
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error(`${label} is malformed.`);
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > nativeSessionListHardCeiling ||
    keys.length !== length + 1
  ) {
    throw new Error(`${label} is malformed.`);
  }
  const sessions: NativeSession[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) throw new Error(`${label} is malformed.`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new Error(`${label} is malformed.`);
    }
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} is malformed.`);
    }
    sessions.push(nativeSession(descriptor.value));
  }
  return sessions;
}

export function parseV2SessionArray(value: unknown): NativeSession[] {
  const response = snapshotDictionary(snapshotEnvelopeData(value, "V2 session listing"), 8);
  if (!response || !Object.hasOwn(response, "data")) throw new Error("V2 listing is malformed.");
  return parseSessionArray(response.data, "V2 listing data");
}

export function parseActiveMap(value: unknown): Record<string, unknown> {
  const response = snapshotEnvelopeData(value, "V2 active status");
  const responseRecord = snapshotDictionary(response);
  const active = responseRecord && snapshotDictionary(responseRecord.data);
  if (!active) {
    throw new Error("V2 active status map is malformed.");
  }
  return active;
}

export function parseActivityMap(value: unknown, label: string): Record<string, unknown> {
  const snapshot = snapshotDictionary(value);
  if (!snapshot) throw new Error(`${label} map is malformed.`);
  return snapshot;
}

function activityStatus(value: unknown): ActivityStatus {
  const entry = snapshotDictionary(value, 4);
  if (!entry) return "unknown";
  if (entry.type === "busy" || entry.type === "idle") return entry.type;
  if (
    entry.type === "retry" &&
    Number.isSafeInteger(entry.attempt) &&
    (entry.attempt as number) >= 0 &&
    typeof entry.message === "string" &&
    typeof entry.next === "number" &&
    Number.isFinite(entry.next) &&
    entry.next >= 0
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
  const legacy = Object.hasOwn(statuses, id) ? activityStatus(statuses[id]) : "idle";
  if (legacy === "busy" || legacy === "retry") return legacy;
  if (!Object.hasOwn(active, id)) return legacy;
  const activeEntry = active[id];
  const snapshot = snapshotDictionary(activeEntry, 2);
  return snapshot?.type === "running" ? "busy" : "unknown";
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
