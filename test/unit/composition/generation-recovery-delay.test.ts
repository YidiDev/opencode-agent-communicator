import { describe, expect, test } from "bun:test";
import {
  createGenerationRecoveryDelay,
  productionGenerationRecoveryDelay,
} from "../../../src/composition/generation-recovery-delay";

describe("generation recovery delay", () => {
  test("completes and removes abort observation through controlled timers", async () => {
    let callback!: () => void;
    let cleared = 0;
    const delay = createGenerationRecoveryDelay(() => 42, {
      set(milliseconds, value) {
        expect(milliseconds).toBe(100);
        callback = value;
        return "timer";
      },
      clear: () => {
        cleared += 1;
      },
    });
    const controller = new AbortController();
    const waiting = delay.wait(100, controller.signal);
    callback();
    controller.abort();
    expect(await waiting).toBe("completed");
    expect(delay.nowMs()).toBe(42);
    expect(cleared).toBe(0);
  });

  test("handles prior and in-flight abort without native time", async () => {
    let clearHandle: unknown;
    const delay = createGenerationRecoveryDelay(Date.now, {
      set: () => "controlled-handle",
      clear: (handle) => {
        clearHandle = handle;
      },
    });
    const prior = new AbortController();
    prior.abort();
    expect(await delay.wait(10, prior.signal)).toBe("aborted");

    const active = new AbortController();
    const waiting = delay.wait(10, active.signal);
    active.abort();
    expect(await waiting).toBe("aborted");
    expect(clearHandle).toBe("controlled-handle");
  });

  test("binds production timers for completion and cancellation", async () => {
    expect(await productionGenerationRecoveryDelay.wait(0, new AbortController().signal)).toBe(
      "completed",
    );
    const controller = new AbortController();
    const waiting = productionGenerationRecoveryDelay.wait(60_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe("aborted");
  });
});
