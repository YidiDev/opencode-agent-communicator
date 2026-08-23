import { requestLimits } from "./request-constants";

export type RequestValidation<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
      readonly bytes: Uint8Array;
      readonly byteLength: number;
    }
  | { readonly ok: false; readonly message: string };

export function isExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

export const requestTextControlPolicy = {
  allowedC0: [0x09, 0x0a, 0x0d],
  rejectedRanges: [
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x202a, 0x202e],
    [0x2066, 0x206f],
  ],
  rejectedCodePoints: [0x061c, 0x200e, 0x200f],
} as const;

export function containsUnsafeRequestTextControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) return true;
    if ((requestTextControlPolicy.allowedC0 as readonly number[]).includes(code)) continue;
    if ((requestTextControlPolicy.rejectedCodePoints as readonly number[]).includes(code))
      return true;
    if (
      requestTextControlPolicy.rejectedRanges.some(([start, end]) => code >= start && code <= end)
    )
      return true;
  }
  return false;
}

export function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function snapshotArray(value: unknown, maximumLength: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) return undefined;
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) snapshot.push(value[index]);
  return snapshot;
}

export function validBoundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumBytes &&
    !containsUnsafeRequestTextControl(value) &&
    new TextEncoder().encode(value).length <= maximumBytes
  );
}

export function validOptionalText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumBytes &&
    !containsUnsafeRequestTextControl(value) &&
    new TextEncoder().encode(value).length <= maximumBytes
  );
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function withinCanonicalLimit(bytes: Uint8Array): boolean {
  return bytes.length <= requestLimits.canonicalContentBytes;
}
