import type { AdvisoryLockId } from "./generated-ids";
import { validateAdvisoryLockId } from "./generated-ids";
import { containsUnsafeRequestTextControl } from "./request-validation";
import type { SessionId } from "./sessions";
import { validateSessionId } from "./sessions";

export const advisoryLockPolicy = Object.freeze({
  titleBytes: 1_024,
  descriptionBytes: 8_192,
  instructionsBytes: 16_384,
  minimumTtlSeconds: 1,
  maximumTtlSeconds: 3_600,
  maximumListLimit: 100,
  maximumCleanupLimit: 1_024,
});

export interface AdvisoryLock {
  readonly lockId: AdvisoryLockId;
  readonly holderSessionId: SessionId;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly createdAtMs: number;
  readonly renewedAtMs: number;
  readonly expiresAtMs: number;
}

export type AdvisoryLockValidation<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly message: string };

function boundedMarkdown(
  value: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty: boolean,
): AdvisoryLockValidation<string> {
  if (typeof value !== "string") return { ok: false, message: `${label} must be a string.` };
  const bytes = new TextEncoder().encode(value).length;
  if (
    bytes > maximumBytes ||
    (!allowEmpty && bytes === 0) ||
    containsUnsafeRequestTextControl(value)
  ) {
    return {
      ok: false,
      message: `${label} must be ${allowEmpty ? `at most ${maximumBytes}` : `between 1 and ${maximumBytes}`} UTF-8 bytes.`,
    };
  }
  return { ok: true, value };
}

export function validateAdvisoryLockTitle(value: unknown): AdvisoryLockValidation<string> {
  return boundedMarkdown(value, "title", advisoryLockPolicy.titleBytes, false);
}

export function validateAdvisoryLockDescription(value: unknown): AdvisoryLockValidation<string> {
  return boundedMarkdown(value, "description", advisoryLockPolicy.descriptionBytes, true);
}

export function validateAdvisoryLockInstructions(value: unknown): AdvisoryLockValidation<string> {
  return boundedMarkdown(value, "instructions", advisoryLockPolicy.instructionsBytes, true);
}

export function validateAdvisoryLockTtlSeconds(value: unknown): AdvisoryLockValidation<number> {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= advisoryLockPolicy.minimumTtlSeconds &&
    value <= advisoryLockPolicy.maximumTtlSeconds
    ? { ok: true, value }
    : { ok: false, message: "ttlSeconds must be an integer from 1 through 3600." };
}

export function isCoherentAdvisoryLock(value: unknown): value is AdvisoryLock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const lock = value as Record<string, unknown>;
  return (
    validateAdvisoryLockId(lock.lockId).ok &&
    validateSessionId(lock.holderSessionId).ok &&
    validateAdvisoryLockTitle(lock.title).ok &&
    validateAdvisoryLockDescription(lock.description).ok &&
    validateAdvisoryLockInstructions(lock.instructions).ok &&
    Number.isSafeInteger(lock.createdAtMs) &&
    (lock.createdAtMs as number) >= 0 &&
    Number.isSafeInteger(lock.renewedAtMs) &&
    (lock.renewedAtMs as number) >= (lock.createdAtMs as number) &&
    Number.isSafeInteger(lock.expiresAtMs) &&
    (lock.expiresAtMs as number) > (lock.renewedAtMs as number)
  );
}
