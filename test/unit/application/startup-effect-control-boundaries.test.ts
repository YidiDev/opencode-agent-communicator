import { expect, test } from "bun:test";
import { createLinkedEffectControl } from "../../../src/application/startup-effect-control";

test("linked effect control rejects missing signals and invalid deadline contracts", () => {
  expect(createLinkedEffectControl({ signals: [] })).toBeUndefined();
  expect(
    createLinkedEffectControl({
      signals: [new AbortController().signal],
      deadlineMs: -1,
      clock: { nowMs: () => 0 },
    }),
  ).toBeUndefined();
  expect(
    createLinkedEffectControl({
      signals: [new AbortController().signal],
      deadlineMs: 1,
    }),
  ).toBeUndefined();
});

test("linked effect control handles already-aborted and invalid rescheduled clocks", () => {
  const stopped = new AbortController();
  stopped.abort();
  const stoppedControl = createLinkedEffectControl({ signals: [stopped.signal] });
  expect(stoppedControl?.signal.aborted).toBe(true);

  let now: unknown = 1;
  let callback: (() => void) | undefined;
  const control = createLinkedEffectControl({
    signals: [new AbortController().signal],
    deadlineMs: 10,
    clock: { nowMs: () => now as number },
    timers: {
      set(_delay, next) {
        callback = next;
        return 1;
      },
      clear() {},
    },
  });
  now = Number.NaN;
  callback?.();
  expect(control?.signal.aborted).toBe(true);
});

test("linked effect control fails closed when listener registration is hostile", () => {
  const hostile = {
    aborted: false,
    addEventListener() {
      throw new Error("listener registration failed");
    },
    removeEventListener() {},
  } as unknown as AbortSignal;
  expect(createLinkedEffectControl({ signals: [hostile] })).toBeUndefined();
});
