import { describe, expect, test } from "bun:test";
import {
  disposeUnpublishedGeneration,
  quiescePartialGeneration,
  rollbackPartialGeneration,
} from "../../../src/composition/communicator-generation-rollback";

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

describe("unpublished generation cleanup quarantine", () => {
  test("waits for positive settlement after drain throws before disposing", async () => {
    const settlement = barrier();
    let disposals = 0;
    const generation = {
      quiesce: () => undefined,
      shutdownUnpublished: () => undefined,
      drainInvocations: async () => {
        throw new Error("drain detail");
      },
      settleInvocations: () => settlement.reached,
      disposeResources: async () => {
        disposals += 1;
      },
    };

    const cleanup = disposeUnpublishedGeneration(generation);
    expect(disposeUnpublishedGeneration(generation)).toBe(cleanup);
    await Promise.resolve();
    expect(disposals).toBe(0);
    settlement.release();
    await cleanup;
    expect(disposals).toBe(1);
  });

  test("quarantines resources when settlement after a thrown drain rejects", async () => {
    let disposals = 0;
    const cleanup = disposeUnpublishedGeneration({
      quiesce: () => undefined,
      shutdownUnpublished: () => undefined,
      drainInvocations: async () => {
        throw new Error("drain detail");
      },
      settleInvocations: async () => {
        throw new Error("settlement detail");
      },
      disposeResources: async () => {
        disposals += 1;
      },
    });

    await cleanup;
    expect(disposals).toBe(0);
  });

  test("immediately disposes participant lifecycles but defers store close until phase settlement", async () => {
    const phase = barrier();
    let deletionDisposals = 0;
    let stopDisposals = 0;
    let storesClosed = 0;
    const resources = {
      lifecycle: { stop: () => undefined, scheduler: { drain: async () => undefined } },
      contextRuntime: { stop: () => undefined },
      runtime: { stop: () => undefined },
      participantOperations: { close: () => undefined, drain: async () => undefined },
      deletion: {
        dispose: async () => {
          deletionDisposals = 1;
        },
      },
      participantStop: {
        dispose: async () => {
          stopDisposals = 1;
        },
      },
      store: {
        close: () => {
          storesClosed += 1;
        },
      },
      exporter: undefined,
      advisory: undefined,
    } as never;

    quiescePartialGeneration(resources);
    expect({ deletionDisposals, stopDisposals, storesClosed }).toEqual({
      deletionDisposals: 1,
      stopDisposals: 1,
      storesClosed: 0,
    });
    const cleanup = phase.reached.then(() => rollbackPartialGeneration(resources));
    await Promise.resolve();
    expect(storesClosed).toBe(0);
    phase.release();
    await cleanup;
    expect({ deletionDisposals, stopDisposals, storesClosed }).toEqual({
      deletionDisposals: 1,
      stopDisposals: 1,
      storesClosed: 1,
    });
  });
});
