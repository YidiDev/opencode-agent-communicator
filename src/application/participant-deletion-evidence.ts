import { type SessionId, validateSessionId } from "../domain/sessions";

export interface OpenCode118DeletedSessionEvidence {
  readonly sessionId: SessionId;
  readonly projectId: string;
  readonly directory: string;
  readonly isRoot: boolean;
}

type DataRecord = Record<string, unknown>;

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): DataRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < required.length ||
      keys.length > required.length + optional.length ||
      keys.some(
        (key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)),
      ) ||
      required.some((key) => !keys.includes(key))
    ) {
      return undefined;
    }
    const result: DataRecord = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function timestamp(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validDiffs(value: unknown): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 1000) return false;
  if (Reflect.ownKeys(value).length !== length + 1) return false;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    const diff = exactRecord(descriptor.value, [
      "file",
      "before",
      "after",
      "additions",
      "deletions",
    ]);
    if (
      !diff ||
      !boundedString(diff.file, 4096) ||
      !boundedString(diff.before, 1_048_576) ||
      !boundedString(diff.after, 1_048_576) ||
      !Number.isSafeInteger(diff.additions) ||
      (diff.additions as number) < 0 ||
      !Number.isSafeInteger(diff.deletions) ||
      (diff.deletions as number) < 0
    )
      return false;
  }
  return true;
}

function validSessionTime(value: unknown): boolean {
  const time = exactRecord(value, ["created", "updated"], ["compacting"]);
  return (
    !!time &&
    timestamp(time.created) &&
    timestamp(time.updated) &&
    (!Object.hasOwn(time, "compacting") || timestamp(time.compacting))
  );
}

function validSummary(value: unknown): boolean {
  const summary = exactRecord(value, ["additions", "deletions", "files"], ["diffs"]);
  if (!summary) return false;
  for (const key of ["additions", "deletions", "files"] as const)
    if (!Number.isSafeInteger(summary[key]) || (summary[key] as number) < 0) return false;
  return !Object.hasOwn(summary, "diffs") || validDiffs(summary.diffs);
}

function validShare(value: unknown): boolean {
  const share = exactRecord(value, ["url"]);
  return !!share && boundedString(share.url, 8192);
}

function validRevert(value: unknown): boolean {
  const revert = exactRecord(value, ["messageID"], ["partID", "snapshot", "diff"]);
  if (!revert || !boundedString(revert.messageID, 512)) return false;
  for (const key of ["partID", "snapshot", "diff"] as const)
    if (Object.hasOwn(revert, key) && !boundedString(revert[key], 1_048_576)) return false;
  return true;
}

function validOptionalSessionData(session: DataRecord): boolean {
  return (
    validSessionTime(session.time) &&
    (!Object.hasOwn(session, "summary") || validSummary(session.summary)) &&
    (!Object.hasOwn(session, "share") || validShare(session.share)) &&
    (!Object.hasOwn(session, "revert") || validRevert(session.revert))
  );
}

/**
 * Parses only the supported OpenCode 1.18 legacy plugin-hook shape. The event has no native
 * message identifier or sequence and therefore cannot prove request admission or promotion.
 */
export function parseOpenCode118SessionDeletedEvent(
  value: unknown,
): OpenCode118DeletedSessionEvidence | undefined {
  const event = exactRecord(value, ["type", "properties"]);
  if (event?.type !== "session.deleted") return undefined;
  const properties = exactRecord(event.properties, ["info"]);
  const session = properties
    ? exactRecord(
        properties.info,
        ["id", "projectID", "directory", "title", "version", "time"],
        ["parentID", "summary", "share", "revert"],
      )
    : undefined;
  const id = session && validateSessionId(session.id);
  if (
    !session ||
    !id?.ok ||
    !boundedString(session.projectID, 512) ||
    session.projectID.length === 0 ||
    !boundedString(session.directory, 4096) ||
    session.directory.length === 0 ||
    !boundedString(session.title, 65_536) ||
    !boundedString(session.version, 256) ||
    (Object.hasOwn(session, "parentID") && !validateSessionId(session.parentID).ok) ||
    !validOptionalSessionData(session)
  ) {
    throw new TypeError("OpenCode session.deleted evidence is malformed.");
  }
  return Object.freeze({
    sessionId: id.value,
    projectId: session.projectID,
    directory: session.directory,
    isRoot: !Object.hasOwn(session, "parentID"),
  });
}

/** Total discriminator used before treating an arbitrary hook event as relevant native evidence. */
export function isOpenCode118SessionDeletedEvent(value: unknown): boolean {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "type");
    return (
      descriptor?.enumerable === true &&
      "value" in descriptor &&
      descriptor.value === "session.deleted"
    );
  } catch {
    return false;
  }
}
