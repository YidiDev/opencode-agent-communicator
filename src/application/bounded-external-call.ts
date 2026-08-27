export type BoundedExternalResult<Value> =
  | { readonly kind: "value"; readonly value: Value }
  | { readonly kind: "expired" }
  | { readonly kind: "rejected"; readonly cause: unknown };

/** Races one external promise against the invocation's absolute deadline and observes late failure. */
export async function boundedExternalCall<Value>(
  operation: () => Promise<Value> | Value,
  abort: AbortSignal,
  deadlineMs: number,
): Promise<BoundedExternalResult<Value>> {
  if (abort.aborted || Date.now() >= deadlineMs) return { kind: "expired" };
  let pending: Promise<Value>;
  try {
    if (abort.aborted || Date.now() >= deadlineMs) return { kind: "expired" };
    pending = Promise.resolve(operation());
  } catch (cause: unknown) {
    return { kind: "rejected", cause };
  }
  pending.catch(() => undefined);
  let expire: (() => void) | undefined;
  const elapsed = new Promise<{ readonly kind: "expired" }>((resolve) => {
    expire = () => resolve({ kind: "expired" });
  });
  const onAbort = (): void => expire?.();
  abort.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, Math.max(1, deadlineMs - Date.now()));
  try {
    return await Promise.race([
      pending.then(
        (value) => ({ kind: "value" as const, value }),
        (cause: unknown) => ({ kind: "rejected" as const, cause }),
      ),
      elapsed,
    ]);
  } finally {
    clearTimeout(timer);
    abort.removeEventListener("abort", onAbort);
  }
}
