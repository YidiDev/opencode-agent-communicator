import { snapshotEnvelopeData } from "./opencode-1-18-21-sessions";

export class NativeAdapterFault extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "NativeAdapterFault";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function envelopeData(value: unknown, label: string): unknown {
  try {
    return snapshotEnvelopeData(value, label);
  } catch (cause: unknown) {
    throw new NativeAdapterFault(`${label} returned malformed data.`, cause);
  }
}

export function method(
  object: unknown,
  key: string,
  label: string,
): (...arguments_: unknown[]) => unknown {
  if (!isRecord(object)) throw new NativeAdapterFault(`${label} is unavailable.`);
  const candidate = object[key];
  if (typeof candidate !== "function") throw new NativeAdapterFault(`${label} is unavailable.`);
  return (...arguments_: unknown[]): unknown => Reflect.apply(candidate, object, arguments_);
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new NativeAdapterFault(message);
  return value;
}
