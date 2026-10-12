import { type SessionId, validateSessionId } from "../domain/sessions";

export interface OpenCode2DeletedSessionEvidence {
  readonly sessionId: SessionId;
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

function parseLocation(value: unknown): string | undefined {
  const location =
    exactRecord(value, ["directory"]) ?? exactRecord(value, ["directory", "workspaceID"]);
  if (
    !location ||
    !boundedString(location.directory, 4096) ||
    (Object.hasOwn(location, "workspaceID") && !boundedString(location.workspaceID, 512))
  )
    return undefined;
  return location.directory;
}

/** Parses only the public OpenCode 2.0.26 durable session.deleted event payload. */
export function parseOpenCode2SessionDeletedEvent(
  value: unknown,
): OpenCode2DeletedSessionEvidence | undefined {
  if (!isOpenCode2SessionDeletedEvent(value)) return undefined;
  const event = exactRecord(
    value,
    ["id", "created", "type", "durable", "data"],
    ["location", "metadata"],
  );
  const durable = event && exactRecord(event.durable, ["aggregateID", "seq", "version"]);
  const data = event && exactRecord(event.data, ["sessionID"]);
  const id = data && validateSessionId(data.sessionID);
  const hasLocation = !!event && Object.hasOwn(event, "location");
  const directory = hasLocation && event ? parseLocation(event.location) : undefined;
  if (
    !event ||
    !boundedString(event.id, 256) ||
    typeof event.created !== "number" ||
    !Number.isFinite(event.created) ||
    event.type !== "session.deleted" ||
    !data ||
    !id?.ok ||
    !durable ||
    durable.aggregateID !== id.value ||
    !Number.isSafeInteger(durable.seq) ||
    (durable.seq as number) < 0 ||
    durable.version !== 2 ||
    (hasLocation && directory === undefined) ||
    (Object.hasOwn(event, "metadata") && !validMetadata(event.metadata))
  ) {
    throw new TypeError("OpenCode session.deleted evidence is malformed.");
  }
  return Object.freeze({
    sessionId: id.value,
    ...(directory === undefined ? {} : { directory }),
  });
}

/** Total discriminator used before treating an arbitrary event as relevant native evidence. */
export function isOpenCode2SessionDeletedEvent(value: unknown): boolean {
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
