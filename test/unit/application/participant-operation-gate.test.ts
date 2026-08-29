import { describe, expect, test } from "bun:test";

import {
  ParticipantOperationAbortedFault,
  ParticipantOperationCapacityFault,
  ParticipantOperationGate,
  ParticipantOperationGateClosedFault,
  participantOperationMaximumQueued,
} from "../../../src/application/participant-operation-gate";
import { validateSessionId } from "../../../src/domain/sessions";
import { deferred } from "../../support/blocking-request-fixture";

function session(value: string) {
  const result = validateSessionId(value);
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const first = session("ses_first");
const second = session("ses_second");
const third = session("ses_third");

describe("participant operation gate", () => {
  test("serializes overlapping canonical key sets without deadlock", async () => {
    const gate = new ParticipantOperationGate();
    const release = deferred<void>();
    const order: string[] = [];
    const left = gate.run([second, first], new AbortController().signal, async () => {
      order.push("left:start");
      await release.promise;
      order.push("left:end");
      return 1;
    });
    const right = gate.run([first, second], new AbortController().signal, async () => {
      order.push("right");
      return 2;
    });
    while (order.length === 0) await Promise.resolve();
    expect(order).toEqual(["left:start"]);
    release.resolve();
    expect(await Promise.all([left, right])).toEqual([1, 2]);
    expect(order).toEqual(["left:start", "left:end", "right"]);
  });

  test("allows disjoint work while retaining overlapping waiters", async () => {
    const gate = new ParticipantOperationGate();
    const release = deferred<void>();
    let disjoint = false;
    const held = gate.run([first], new AbortController().signal, () => release.promise);
    const blocked = gate.run([first], new AbortController().signal, async () => undefined);
    await gate.run([third], new AbortController().signal, async () => {
      disjoint = true;
    });
    expect(disjoint).toBe(true);
    release.resolve();
    await Promise.all([held, blocked]);
  });

  test("removes cancelled waiters and admits their successors", async () => {
    const gate = new ParticipantOperationGate();
    const release = deferred<void>();
    const held = gate.run([first], new AbortController().signal, () => release.promise);
    const abort = new AbortController();
    const cancelled = gate.run([first], abort.signal, async () => "cancelled");
    const successor = gate.run([first], new AbortController().signal, async () => "successor");
    abort.abort("cancelled");
    await expect(cancelled).rejects.toBeInstanceOf(ParticipantOperationAbortedFault);
    release.resolve();
    expect(await successor).toBe("successor");
    await held;
  });

  test("bounds queued work and validates keys", async () => {
    const gate = new ParticipantOperationGate();
    const release = deferred<void>();
    const held = gate.run([first], new AbortController().signal, () => release.promise);
    const queued = Array.from({ length: participantOperationMaximumQueued }, () =>
      gate.run([first], new AbortController().signal, async () => undefined),
    );
    await expect(
      gate.run([first], new AbortController().signal, async () => undefined),
    ).rejects.toBeInstanceOf(ParticipantOperationCapacityFault);
    gate.close();
    await Promise.allSettled(queued);
    release.resolve();
    await held;

    const malformed = new ParticipantOperationGate();
    await expect(
      malformed.run([], new AbortController().signal, async () => undefined),
    ).rejects.toThrow("keys are malformed");
    await expect(
      malformed.run(["bad" as never], new AbortController().signal, async () => undefined),
    ).rejects.toThrow("key is malformed");
  });

  test("close rejects queued and future work while drain waits for active work", async () => {
    const gate = new ParticipantOperationGate();
    const release = deferred<void>();
    const active = gate.run([first], new AbortController().signal, () => release.promise);
    const queued = gate.run([first], new AbortController().signal, async () => undefined);
    gate.close();
    gate.close();
    await expect(queued).rejects.toBeInstanceOf(ParticipantOperationGateClosedFault);
    await expect(
      gate.run([second], new AbortController().signal, async () => undefined),
    ).rejects.toBeInstanceOf(ParticipantOperationGateClosedFault);
    let drained = false;
    const draining = gate.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await Promise.all([active, draining]);
    expect(drained).toBe(true);
  });

  test("rejects an already-aborted acquisition and releases after operation failure", async () => {
    const gate = new ParticipantOperationGate();
    const abort = new AbortController();
    abort.abort("cancelled");
    await expect(gate.run([first], abort.signal, async () => undefined)).rejects.toBeInstanceOf(
      ParticipantOperationAbortedFault,
    );
    await expect(
      gate.run([first, first], new AbortController().signal, async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    expect(await gate.run([first], new AbortController().signal, async () => "released")).toBe(
      "released",
    );
  });
});
