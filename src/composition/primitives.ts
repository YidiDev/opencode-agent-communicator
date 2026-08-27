import { createHash, randomBytes } from "node:crypto";
import type { RequestDeadlineTimerPort } from "../application/blocking-session-request-boundaries";
import type { ClockPort } from "../application/delivery-ports";
import type { RequestDeadlineTimerPort as SchedulerTimerPort } from "../application/request-deadline-scheduler";
import type { StartupDeadlineTimerPort } from "../application/startup-effect-control";
import type { CryptographicEntropyPort } from "../domain/generated-ids";
import type { RuntimeIdentityPort } from "../domain/host";
import type { Sha256DigestPort } from "../domain/message-payload";

export const productionRuntimeIdentity: RuntimeIdentityPort = Object.freeze({
  readIdentity(): unknown {
    return Object.freeze({
      platform: process.platform,
      architecture: process.arch,
    });
  },
});

export const productionClock: ClockPort = Object.freeze({
  nowMs(): number {
    const value = Date.now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("The system wall clock is invalid.");
    return value;
  },
});

export const productionEntropy: CryptographicEntropyPort = Object.freeze({
  randomBytes(length: number): Uint8Array {
    return new Uint8Array(randomBytes(length));
  },
});

export const productionSha256: Sha256DigestPort = Object.freeze({
  async sha256(input: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHash("sha256").update(input).digest());
  },
});

export const productionBlockingTimers: RequestDeadlineTimerPort = Object.freeze({
  arm(delayMs: number, wake: () => void) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0)
      throw new TypeError("Timer delay is invalid.");
    const handle = setTimeout(wake, delayMs);
    let cancelled = false;
    return Object.freeze({
      cancel(): void {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(handle);
      },
    });
  },
});

function setValidatedTimer(delayMs: number, callback: () => void): () => void {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new TypeError("Timer delay is invalid.");
  const nativeHandle = setTimeout(callback, delayMs);
  return () => clearTimeout(nativeHandle);
}

function clearValidatedTimer(handle: unknown): void {
  if (typeof handle !== "function") throw new TypeError("Timer handle is invalid.");
  Reflect.apply(handle, undefined, []);
}

export const productionSchedulerTimers: SchedulerTimerPort = Object.freeze({
  set: setValidatedTimer,
  clear: clearValidatedTimer,
});

export const productionStartupTimers: StartupDeadlineTimerPort = Object.freeze({
  set: setValidatedTimer,
  clear: clearValidatedTimer,
});

export function productionMonotonicNowMs(): number {
  const value = performance.now();
  if (!Number.isFinite(value) || value < 0)
    throw new Error("The system monotonic clock is invalid.");
  return value;
}
