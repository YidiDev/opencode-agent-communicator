import { type SessionId, validateSessionId } from "../domain/sessions";

export interface OpenCode118ParticipantActivityEvidence {
  readonly sessionId: SessionId;
  readonly activity: "busy" | "retry" | "idle";
}

type DataRecord = Record<string, unknown>;

function exactRecord(value: unknown, required: readonly string[]): DataRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== required.length ||
      keys.some((key) => typeof key !== "string" || !required.includes(key)) ||
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

function parseStatus(value: unknown): "busy" | "retry" | "idle" | undefined {
  const record = exactRecord(value, ["type"]);
  if (record?.type === "busy" || record?.type === "idle") return record.type;
  const retry = exactRecord(value, ["type", "attempt", "message", "next"]);
  if (
    retry?.type !== "retry" ||
    !Number.isSafeInteger(retry.attempt) ||
    (retry.attempt as number) < 0 ||
    typeof retry.message !== "string" ||
    retry.message.length > 65_536 ||
    typeof retry.next !== "number" ||
    !Number.isFinite(retry.next) ||
    retry.next < 0
  )
    return undefined;
  return "retry";
}

/** Parses only the pinned OpenCode 1.18 idle and status hook shapes. */
export function parseOpenCode118ParticipantActivityEvent(
  value: unknown,
): OpenCode118ParticipantActivityEvidence | undefined {
  if (!isOpenCode118ParticipantActivityEvent(value)) return undefined;
  const event =
    exactRecord(value, ["type", "properties"]) ?? exactRecord(value, ["id", "type", "properties"]);
  if (
    !event ||
    (event.id !== undefined &&
      (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 256)) ||
    (event.type !== "session.idle" && event.type !== "session.status")
  ) {
    throw new TypeError("OpenCode participant activity evidence is malformed.");
  }
  const properties =
    event.type === "session.idle"
      ? exactRecord(event.properties, ["sessionID"])
      : exactRecord(event.properties, ["sessionID", "status"]);
  const id = properties && validateSessionId(properties.sessionID);
  const activity =
    event.type === "session.idle" ? "idle" : properties && parseStatus(properties.status);
  if (!properties || !id?.ok || activity === undefined) {
    throw new TypeError(`OpenCode ${String(event.type)} evidence is malformed.`);
  }
  return Object.freeze({ sessionId: id.value, activity });
}

export function isOpenCode118ParticipantActivityEvent(value: unknown): boolean {
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
