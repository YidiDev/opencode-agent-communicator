export interface InvocationDrainTimerPort {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export type InvocationAdmissionResult<Value> =
  | { readonly admitted: true; readonly value: Value }
  | { readonly admitted: false; readonly reason: "closed" | "cancelled" };

const invocationDrainTimers: InvocationDrainTimerPort = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ActiveInvocationRegistry {
  private readonly active = new Map<Promise<unknown>, AbortController>();
  private admissionClosed = false;
  private drainPromise: Promise<"drained" | "timed_out"> | undefined;
  private settlementPromise: Promise<void> | undefined;
  private settle: (() => void) | undefined;

  constructor(
    private readonly shutdownDeadlineMs = 2_000,
    private readonly timers: InvocationDrainTimerPort = invocationDrainTimers,
  ) {
    if (!Number.isSafeInteger(shutdownDeadlineMs) || shutdownDeadlineMs < 1) {
      throw new TypeError("Invocation shutdown deadline is invalid.");
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  async run<Value>(
    caller: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    const result = await this.execute(caller, operation, "ordinary");
    if (!result.admitted)
      throw new Error("Communicator is shutting down; invocation admission is closed.");
    return result.value;
  }

  async runWithAdmission<Value>(
    caller: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<InvocationAdmissionResult<Value>> {
    return this.execute(caller, operation, "managed");
  }

  private async execute<Value>(
    caller: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Value>,
    mode: "managed" | "ordinary",
  ): Promise<InvocationAdmissionResult<Value>> {
    if (mode === "managed" && caller.aborted) return { admitted: false, reason: "cancelled" };
    if (this.admissionClosed) return { admitted: false, reason: "closed" };
    const controller = new AbortController();
    const relay = (): void => controller.abort(caller.reason);
    caller.addEventListener("abort", relay, { once: true });
    if (caller.aborted) relay();
    const execution = Promise.resolve().then(
      async (): Promise<InvocationAdmissionResult<Value>> => {
        if (mode === "managed" && caller.aborted) return { admitted: false, reason: "cancelled" };
        if (mode === "managed" && this.admissionClosed)
          return { admitted: false, reason: "closed" };
        return { admitted: true, value: await operation(controller.signal) };
      },
    );
    this.active.set(execution, controller);
    try {
      return await execution;
    } finally {
      caller.removeEventListener("abort", relay);
      this.active.delete(execution);
      if (this.admissionClosed && this.active.size === 0) this.settle?.();
    }
  }

  closeAdmission(reason = "communicator_shutdown"): void {
    if (this.admissionClosed) return;
    this.admissionClosed = true;
    for (const [execution, controller] of this.active) {
      execution.catch(() => undefined);
      controller.abort(reason);
    }
  }

  drain(): Promise<"drained" | "timed_out"> {
    this.closeAdmission();
    this.drainPromise ??= this.drainWithinBound();
    return this.drainPromise;
  }

  settled(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    this.settlementPromise ??= new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    return this.settlementPromise;
  }

  async shutdown(): Promise<void> {
    await this.drain();
  }

  private async drainWithinBound(): Promise<"drained" | "timed_out"> {
    const snapshot = [...this.active.keys()];
    if (snapshot.length === 0) return "drained";
    let timer: unknown;
    try {
      return await Promise.race([
        Promise.allSettled(snapshot).then(() => "drained" as const),
        new Promise<"timed_out">((resolve) => {
          timer = this.timers.set(this.shutdownDeadlineMs, () => resolve("timed_out"));
        }),
      ]);
    } finally {
      if (timer !== undefined) this.timers.clear(timer);
    }
  }
}
