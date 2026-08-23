import { observeNativePromiseRejection } from "./native-promise-observation";

export type AbortableSettlement<Value> =
  | Readonly<{ readonly kind: "settled"; readonly value: Value }>
  | Readonly<{ readonly kind: "rejected"; readonly cause: unknown }>
  | Readonly<{ readonly kind: "aborted" }>;

/**
 * Starts an operation only while the signal is active, bounds its settlement, and converts a
 * synchronous port throw into the same rejected branch. A promise that loses the abort race stays
 * observed, so hostile or late adapter rejection cannot become unhandled.
 */
export function runUntilAborted<Value>(
  signal: AbortSignal,
  operation: () => Promise<Value>,
): Promise<AbortableSettlement<Value>> {
  if (signal.aborted) return Promise.resolve({ kind: "aborted" });
  let promise: Promise<Value>;
  try {
    promise = operation();
  } catch (cause: unknown) {
    return Promise.resolve({ kind: "rejected", cause });
  }
  return settleUntilAborted(promise, signal);
}

/** Bounds a native Promise by a signal and keeps a late rejection observed after interruption. */
export async function settleUntilAborted<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<AbortableSettlement<Value>> {
  if (signal.aborted) {
    observeNativePromiseRejection(promise);
    return { kind: "aborted" };
  }
  let remove: (() => void) | undefined;
  const aborted = new Promise<AbortableSettlement<Value>>((resolve) => {
    const listener = (): void => resolve({ kind: "aborted" });
    signal.addEventListener("abort", listener, { once: true });
    remove = () => signal.removeEventListener("abort", listener);
  });
  const settled = Promise.prototype.then.call(
    promise,
    (value: Value) => ({ kind: "settled" as const, value }),
    (cause: unknown) => ({ kind: "rejected" as const, cause }),
  ) as Promise<AbortableSettlement<Value>>;
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    remove?.();
    observeNativePromiseRejection(promise);
  }
}
