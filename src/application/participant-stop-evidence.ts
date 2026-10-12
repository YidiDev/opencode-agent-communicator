import { type SessionId, validateSessionId } from "../domain/sessions";

export interface OpenCode2ParticipantActivityEvidence {
  readonly sessionId: SessionId;
  readonly activity: "busy" | "retry" | "idle";
  readonly directory?: string;
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
    )
      return undefined;
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
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validMetadata(value: unknown): boolean {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 1_000 || keys.some((key) => typeof key !== "string")) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function parseLocation(value: unknown): string | undefined | false {
  const location =
    exactRecord(value, ["directory"]) ?? exactRecord(value, ["directory", "workspaceID"]);
  if (!location || !boundedString(location.directory, 4096)) return false;
  if (Object.hasOwn(location, "workspaceID") && !boundedString(location.workspaceID, 512)) {
    return false;
  }
  return location.directory;
}

export function parseOpenCode2ParticipantStatus(
  value: unknown,
): "busy" | "retry" | "idle" | undefined {
  const record = exactRecord(value, ["type"]);
  if (record?.type === "busy" || record?.type === "idle") return record.type;
  const retry =
    exactRecord(value, ["type", "attempt", "message", "next"]) ??
    exactRecord(value, ["type", "attempt", "message", "action", "next"]);
  if (
    retry?.type !== "retry" ||
    !Number.isSafeInteger(retry.attempt) ||
    (retry.attempt as number) < 0 ||
    typeof retry.message !== "string" ||
    retry.message.length > 65_536 ||
    !Number.isSafeInteger(retry.next) ||
    (retry.next as number) < 0
  )
    return undefined;
  if (Object.hasOwn(retry, "action")) {
    const action =
      exactRecord(retry.action, ["reason", "provider", "title", "message", "label"]) ??
      exactRecord(retry.action, ["reason", "provider", "title", "message", "label", "link"]);
    if (
      !action ||
      [action.reason, action.provider, action.title, action.message, action.label].some(
        (item) => typeof item !== "string" || item.length > 65_536,
      ) ||
      (Object.hasOwn(action, "link") &&
        (typeof action.link !== "string" || action.link.length > 65_536))
    )
      return undefined;
  }
  return "retry";
}

/** Parses only the public OpenCode 2.0.26 idle and status event payloads. */
export function parseOpenCode2ParticipantActivityEvent(
  value: unknown,
): OpenCode2ParticipantActivityEvidence | undefined {
  if (!isOpenCode2ParticipantActivityEvent(value)) return undefined;
  const event = exactRecord(value, ["id", "created", "type", "data"], ["location", "metadata"]);
  if (
    !event ||
    !boundedString(event.id, 256) ||
    typeof event.created !== "number" ||
    !Number.isFinite(event.created) ||
    (event.type !== "session.idle" && event.type !== "session.status") ||
    (Object.hasOwn(event, "metadata") && !validMetadata(event.metadata))
  ) {
    throw new TypeError("OpenCode participant activity evidence is malformed.");
  }
  const directory = Object.hasOwn(event, "location") ? parseLocation(event.location) : undefined;
  const data =
    event.type === "session.idle"
      ? exactRecord(event.data, ["sessionID"])
      : exactRecord(event.data, ["sessionID", "status"]);
  const id = data && validateSessionId(data.sessionID);
  const activity =
    event.type === "session.idle" ? "idle" : data && parseOpenCode2ParticipantStatus(data.status);
  if (directory === false || !data || !id?.ok || activity === undefined) {
    throw new TypeError(`OpenCode ${String(event.type)} evidence is malformed.`);
  }
  return Object.freeze({
    sessionId: id.value,
    activity,
    ...(directory === undefined ? {} : { directory }),
  });
}

export function isOpenCode2ParticipantActivityEvent(value: unknown): boolean {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "type");
    return (
      descriptor?.enumerable === true &&
      "value" in descriptor &&
      (descriptor.value === "session.idle" || descriptor.value === "session.status")
    );
  } catch {
    return false;
  }
}
