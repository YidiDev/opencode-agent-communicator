import { describe, expect, test } from "bun:test";
import {
  productionBlockingTimers,
  productionClock,
  productionEntropy,
  productionMonotonicNowMs,
  productionSchedulerTimers,
  productionSha256,
  productionStartupTimers,
} from "../../../src/composition/primitives";

describe("production composition primitives", () => {
  test("provides bounded clock, entropy, and SHA-256 adapters", async () => {
    expect(Number.isSafeInteger(productionClock.nowMs())).toBe(true);
    expect(productionMonotonicNowMs()).toBeGreaterThanOrEqual(0);
    expect(productionEntropy.randomBytes(12)).toHaveLength(12);
    expect(
      Buffer.from(await productionSha256.sha256(new TextEncoder().encode("abc"))).toString("hex"),
    ).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("arms cancellable blocking timers and validates delays", async () => {
    let wakes = 0;
    const completed = new Promise<void>((resolve) => {
      productionBlockingTimers.arm(0, () => {
        wakes += 1;
        resolve();
      });
    });
    await completed;
    const cancelled = productionBlockingTimers.arm(20, () => {
      wakes += 1;
    });
    cancelled.cancel();
    cancelled.cancel();
    await Bun.sleep(30);
    expect(wakes).toBe(1);
    expect(() => productionBlockingTimers.arm(-1, () => undefined)).toThrow("delay");
  });

  test("shares validated set/clear behavior across scheduler and startup timers", async () => {
    for (const timers of [productionSchedulerTimers, productionStartupTimers]) {
      let fired = false;
      const handle = timers.set(20, () => {
        fired = true;
      });
      timers.clear(handle);
      expect(() => timers.set(Number.NaN, () => undefined)).toThrow("delay");
      expect(() => timers.clear({})).toThrow("handle");
      await Bun.sleep(25);
      expect(fired).toBe(false);
    }
  });
});
