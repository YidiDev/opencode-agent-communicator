export interface GenerationRecoveryDelayPort {
  nowMs(): number;
  wait(delayMs: number, abort: AbortSignal): Promise<"completed" | "aborted">;
}

export interface GenerationRecoveryTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const productionTimers: GenerationRecoveryTimerPort = {
  set: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createGenerationRecoveryDelay(
  nowMs: () => number,
  timers: GenerationRecoveryTimerPort,
): GenerationRecoveryDelayPort {
  return Object.freeze({
    nowMs,
    wait(delayMs: number, abort: AbortSignal): Promise<"completed" | "aborted"> {
      if (abort.aborted) return Promise.resolve("aborted");
      return new Promise<"completed" | "aborted">((resolve) => {
        const onAbort = (): void => {
          timers.clear(timer);
          resolve("aborted");
        };
        const timer = timers.set(delayMs, () => {
          abort.removeEventListener("abort", onAbort);
          resolve("completed");
        });
        abort.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
}

export const productionGenerationRecoveryDelay = createGenerationRecoveryDelay(
  Date.now,
  productionTimers,
);
