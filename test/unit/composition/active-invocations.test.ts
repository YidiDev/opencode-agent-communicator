import { describe, expect, test } from "bun:test";
import { ActiveInvocationRegistry } from "../../../src/composition/active-invocations";

describe("active invocation lifecycle", () => {
  test("validates its shutdown bound and makes empty shutdown idempotent", async () => {
    for (const deadline of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new ActiveInvocationRegistry(deadline)).toThrow("deadline");
    }
    const registry = new ActiveInvocationRegistry(1);
    await registry.shutdown();
    await registry.shutdown();
  });

  test("relays an already-aborted caller and removes completed work", async () => {
    const caller = new AbortController();
    caller.abort("caller_cancelled");
    const registry = new ActiveInvocationRegistry();
    expect(
      await registry.run(caller.signal, async (signal) => ({
        aborted: signal.aborted,
        reason: signal.reason,
      })),
    ).toEqual({ aborted: true, reason: "caller_cancelled" });
    await registry.shutdown();
  });

  test("aborts and drains active work, rejects new work, and disposes concurrently", async () => {
    const registry = new ActiveInvocationRegistry();
    let observedAbort = false;
    const operation = registry.run(
      new AbortController().signal,
      (signal) =>
        new Promise<string>((resolve) => {
          const settle = (): void => {
            observedAbort = true;
            resolve("settled");
          };
          if (signal.aborted) {
            settle();
            return;
          }
          signal.addEventListener("abort", settle, { once: true });
        }),
    );
    const first = registry.shutdown();
    const second = registry.shutdown();
    await Promise.all([first, second]);
    expect(await operation).toBe("settled");
    expect(observedAbort).toBe(true);
    await expect(registry.run(new AbortController().signal, async () => "late")).rejects.toThrow(
      "shutting down",
    );
  });

  test("returns at the shutdown bound for noncooperative work and observes late rejection", async () => {
    const registry = new ActiveInvocationRegistry(10);
    let rejectLate: ((cause: unknown) => void) | undefined;
    const quarantined = registry.run(
      new AbortController().signal,
      () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
    );
    quarantined.catch(() => undefined);
    await Promise.resolve();
    const started = Date.now();
    await registry.shutdown();
    expect(Date.now() - started).toBeLessThan(100);
    rejectLate?.(new Error("late quarantined rejection"));
    await Promise.resolve();
  });

  test("reports a controlled timeout without deleting unresolved work", async () => {
    let fire: (() => void) | undefined;
    const registry = new ActiveInvocationRegistry(20, {
      set(_delay, callback) {
        fire = callback;
        return callback;
      },
      clear: () => undefined,
    });
    let settle!: () => void;
    const operation = registry.run(
      new AbortController().signal,
      () => new Promise<void>((resolve) => (settle = resolve)),
    );
    await Promise.resolve();
    const drain = registry.drain();
    fire?.();
    expect(await drain).toBe("timed_out");
    expect(registry.activeCount).toBe(1);
    const eventualSettlement = registry.settled();
    settle();
    await operation;
    await eventualSettlement;
    expect(registry.activeCount).toBe(0);
  });
});
