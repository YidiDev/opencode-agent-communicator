import type { ClockPort } from "./delivery-ports";

export interface StartupDeadlineTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const nativeTimers: StartupDeadlineTimerPort = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LinkedStartupEffectControl {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Links any number of cancellation sources and an optional absolute wall-clock deadline. */
export function createLinkedEffectControl(input: {
  readonly signals: readonly AbortSignal[];
  readonly deadlineMs?: number;
  readonly clock?: ClockPort;
  readonly timers?: StartupDeadlineTimerPort;
}): LinkedStartupEffectControl | undefined {
  const controller = new AbortController();
  const timers = input.timers ?? nativeTimers;
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  let handle: unknown;
  let armed = false;
  let disposed = false;
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort("startup_interrupted");
  };
  const armDeadline = (nowMs: number): void => {
    if (input.deadlineMs === undefined || input.clock === undefined) {
      abort();
      return;
    }
    const deadlineMs = input.deadlineMs;
    const clock = input.clock;
    const delay = deadlineMs - nowMs;
    if (!Number.isSafeInteger(delay) || delay < 1) {
      abort();
      return;
    }
    handle = timers.set(Math.min(delay, 2_147_483_647), () => {
      armed = false;
      try {
        const current: unknown = clock.nowMs();
        if (!Number.isSafeInteger(current) || (current as number) < 0) abort();
        else if ((current as number) >= deadlineMs) abort();
        else armDeadline(current as number);
      } catch {
        abort();
      }
    });
    armed = true;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    if (armed) {
      armed = false;
      timers.clear(handle);
    }
  };
  try {
    const uniqueSignals = new Set(input.signals);
    if (uniqueSignals.size === 0) return undefined;
    for (const signal of uniqueSignals) {
      if (signal.aborted) abort();
      else {
        const listener = (): void => abort();
        signal.addEventListener("abort", listener, { once: true });
        listeners.push([signal, listener]);
      }
    }
    if (input.deadlineMs !== undefined) {
      if (
        !Number.isSafeInteger(input.deadlineMs) ||
        input.deadlineMs < 0 ||
        input.clock === undefined
      ) {
        dispose();
        return undefined;
      }
      const now: unknown = input.clock.nowMs();
      if (
        !Number.isSafeInteger(now) ||
        (now as number) < 0 ||
        (now as number) >= input.deadlineMs
      ) {
        abort();
      } else if (!controller.signal.aborted) {
        armDeadline(now as number);
      }
    }
    return Object.freeze({ signal: controller.signal, dispose });
  } catch {
    try {
      dispose();
    } catch {
      // Invalid injected cleanup remains an invalid startup timer contract.
    }
    return undefined;
  }
}

/** Startup-specific convenience wrapper linking caller and process lifecycle cancellation. */
export function createLinkedStartupEffectControl(input: {
  readonly caller: AbortSignal;
  readonly runtime: AbortSignal;
  readonly deadlineMs: number;
  readonly clock: ClockPort;
  readonly timers?: StartupDeadlineTimerPort;
}): LinkedStartupEffectControl | undefined {
  return createLinkedEffectControl({
    signals: [input.caller, input.runtime],
    deadlineMs: input.deadlineMs,
    clock: input.clock,
    ...(input.timers ? { timers: input.timers } : {}),
  });
}
