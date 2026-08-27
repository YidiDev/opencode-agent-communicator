export class ActiveInvocationRegistry {
  private readonly active = new Map<Promise<unknown>, AbortController>();
  private isShuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly shutdownDeadlineMs = 2_000) {
    if (!Number.isSafeInteger(shutdownDeadlineMs) || shutdownDeadlineMs < 1) {
      throw new TypeError("Invocation shutdown deadline is invalid.");
    }
  }

  async run<Value>(
    caller: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    if (this.isShuttingDown) throw new Error("Communicator is shutting down.");
    const controller = new AbortController();
    const relay = (): void => controller.abort(caller.reason);
    caller.addEventListener("abort", relay, { once: true });
    if (caller.aborted) relay();
    const execution = Promise.resolve().then(() => operation(controller.signal));
    this.active.set(execution, controller);
    try {
      return await execution;
    } finally {
      caller.removeEventListener("abort", relay);
      this.active.delete(execution);
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownWithinBound();
    return this.shutdownPromise;
  }

  private async shutdownWithinBound(): Promise<void> {
    this.isShuttingDown = true;
    const snapshot = [...this.active.entries()];
    for (const [execution, controller] of snapshot) {
      // Observe rejection for the entire quarantined lifetime, not only until the bound elapses.
      execution.catch(() => undefined);
      controller.abort("communicator_shutdown");
    }
    if (snapshot.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(snapshot.map(([execution]) => execution)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.shutdownDeadlineMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      for (const [execution] of snapshot) this.active.delete(execution);
    }
  }
}
