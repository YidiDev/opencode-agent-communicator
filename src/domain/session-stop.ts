import type { Sha256Digest, Sha256DigestPort } from "./message-payload";

export const sessionStopReasonMaximumBytes = 1_024;

export type SessionStopReason = string & { readonly sessionStopReason: unique symbol };

export type SessionStopReasonValidation =
  | { readonly ok: true; readonly value?: SessionStopReason; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly message: string };

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Absence is tagged so its approval digest cannot collide with any supplied UTF-8 reason. */
export function validateSessionStopReason(value: unknown): SessionStopReasonValidation {
  if (value === undefined) {
    return { ok: true, bytes: new TextEncoder().encode("session-stop-reason:absent") };
  }
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, message: "Stop reason must be a non-empty string when supplied." };
  }
  if (/\0|[\u202a-\u202e\u2066-\u2069]/u.test(value) || hasUnpairedSurrogate(value)) {
    return { ok: false, message: "Stop reason contains unsafe control characters." };
  }
  const reasonBytes = new TextEncoder().encode(value);
  if (reasonBytes.length > sessionStopReasonMaximumBytes) {
    return { ok: false, message: "Stop reason exceeds the 1024-byte limit." };
  }
  const tagged = new Uint8Array("session-stop-reason:present:".length + reasonBytes.length);
  tagged.set(new TextEncoder().encode("session-stop-reason:present:"));
  tagged.set(reasonBytes, "session-stop-reason:present:".length);
  return { ok: true, value: value as SessionStopReason, bytes: tagged };
}

export async function digestSessionStopReason(
  digest: Sha256DigestPort,
  validated: SessionStopReasonValidation & { readonly ok: true },
): Promise<Sha256Digest> {
  const output = await digest.sha256(validated.bytes);
  if (!(output instanceof Uint8Array) || output.length !== 32) {
    throw new TypeError("Stop reason digest adapter returned malformed output.");
  }
  return [...output].map((byte) => byte.toString(16).padStart(2, "0")).join("") as Sha256Digest;
}
