import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ActiveInvocationRegistry } from "../../../src/composition/active-invocations";
import { CommunicatorGenerationConstructionError } from "../../../src/composition/communicator-generation-errors";
import {
  type CommunicatorGenerationHandle,
  CommunicatorGenerationManager,
} from "../../../src/composition/communicator-generation-manager";

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

function generation(
  token: number,
  options: {
    stopped?: boolean;
    drain?: "drained" | "timed_out";
    takeoverDelayMs?: number;
    settlement?: Promise<void>;
    execute?: (signal: AbortSignal) => Promise<string>;
    disposed?: () => void;
  } = {},
): CommunicatorGenerationHandle {
  const invocations = new ActiveInvocationRegistry();
  const lifecycle = {
    fencingToken: token,
    status: options.stopped ? "stopped" : "ready",
    stopState: options.stopped
      ? {
          cause: "ownership_lost",
          reason: "ownership_lost",
          recoverable: true,
          diagnostic: "Communicator ownership ended.",
        }
      : undefined,
  };
  return {
    lifecycle: lifecycle as never,
    invocations,
    fencingToken: token as never,
    contracts: {
      session_list: {
        description: "fixture",
        args: z.object({}).strict(),
        execute: async (_arguments: unknown, context: { abort: AbortSignal }) =>
          options.execute?.(context.abort) ?? `generation-${token}`,
      },
    } as never,
    event: async () => undefined,
    chat: async () => undefined,
    quiesce() {
      invocations.closeAdmission("ownership_lost");
    },
    async drainInvocations() {
      if (options.drain) return options.drain;
      return invocations.drain();
    },
    settleInvocations: () => options.settlement ?? invocations.settled(),
    ownershipTakeoverDelayMs: () => options.takeoverDelayMs ?? 0,
    async disposeResources() {
      options.disposed?.();
    },
  };
}

const immediateDelay = {
  nowMs: () => 1_000,
  wait: async () => "completed" as const,
};

function createManager(
  initial: CommunicatorGenerationHandle,
  create: (deadlineMs: number) => Promise<CommunicatorGenerationHandle>,
) {
  return new CommunicatorGenerationManager(initial, create, immediateDelay, 1_000);
}

function invoke(manager: CommunicatorGenerationManager): Promise<string> {
  return manager.invoke(
    "session_list",
    new AbortController().signal,
    (contract, context) => contract.execute({}, context),
    { sessionID: "session", messageID: "message", ask: async () => undefined },
  );
}

describe("communicator generation recovery", () => {
  test("shares one recovery, publishes atomically, and advances the fencing epoch", async () => {
    const stale = generation(1, { stopped: true });
    const successor = generation(2);
    const build = barrier();
    const buildStarted = barrier();
    let builds = 0;
    const manager = createManager(stale, async () => {
      builds += 1;
      buildStarted.release();
      await build.reached;
      return successor;
    });

    const first = invoke(manager);
    const second = invoke(manager);
    await buildStarted.reached;
    expect(manager.state).toBe("recovering");
    expect(manager.current).toBe(stale);
    expect(builds).toBe(1);
    build.release();
    expect(await Promise.all([first, second])).toEqual(["generation-2", "generation-2"]);
    expect(manager.current).toBe(successor);
    expect(Number(manager.current.fencingToken)).toBe(2);
  });

  test("never transfers an invocation whose callback started on the stale generation", async () => {
    const started = barrier();
    const finish = barrier();
    let staleExecutions = 0;
    let successorExecutions = 0;
    const stale = generation(1, {
      execute: async () => {
        staleExecutions += 1;
        started.release();
        await finish.reached;
        return "stale-result";
      },
    });
    const successor = generation(2, {
      execute: async () => {
        successorExecutions += 1;
        return "successor-result";
      },
    });
    const manager = createManager(stale, async () => successor);

    const oldInvocation = invoke(manager);
    await started.reached;
    (stale.lifecycle as { status: string; stopState?: unknown }).status = "stopped";
    (stale.lifecycle as { stopState?: unknown }).stopState = {
      cause: "ownership_lost",
      reason: "ownership_lost",
      recoverable: true,
      diagnostic: "Communicator ownership ended.",
    };
    const laterInvocation = invoke(manager);
    finish.release();
    expect(await oldInvocation).toBe("stale-result");
    expect(await laterInvocation).toBe("successor-result");
    expect({ staleExecutions, successorExecutions }).toEqual({
      staleExecutions: 1,
      successorExecutions: 1,
    });
  });
});

describe("communicator generation recovery failures", () => {
  test("rejects an invalid recovery startup bound", () => {
    expect(
      () =>
        new CommunicatorGenerationManager(
          generation(1),
          async () => generation(2),
          immediateDelay,
          0,
        ),
    ).toThrow("startup deadline");
  });

  test("makes drain timeout and recovery failure sticky without constructing a successor", async () => {
    let builds = 0;
    let disposals = 0;
    const settlement = barrier();
    const disposed = barrier();
    const manager = createManager(
      generation(4, {
        stopped: true,
        drain: "timed_out",
        settlement: settlement.reached,
        disposed: () => {
          disposals += 1;
          disposed.release();
        },
      }),
      async () => {
        builds += 1;
        return generation(5);
      },
    );
    await expect(invoke(manager)).rejects.toThrow("drain timed out");
    await expect(invoke(manager)).rejects.toThrow("drain timed out");
    expect(manager.state).toBe("failed");
    expect({ builds, disposals }).toEqual({ builds: 0, disposals: 0 });
    settlement.release();
    await disposed.reached;
    expect(disposals).toBe(1);
  });

  test("plugin disposal awaits late invocation settlement before one resource cleanup", async () => {
    const settlement = barrier();
    let disposals = 0;
    const manager = createManager(
      generation(1, {
        drain: "timed_out",
        settlement: settlement.reached,
        disposed: () => {
          disposals += 1;
        },
      }),
      async () => generation(2),
    );
    const disposal = manager.dispose();
    await Promise.resolve();
    expect(disposals).toBe(0);
    settlement.release();
    await disposal;
    expect(disposals).toBe(1);
    await manager.dispose();
    expect(disposals).toBe(1);
  });

  test("waits once for persisted takeover eligibility before constructing the successor", async () => {
    let nowMs = 5_000;
    const waiting = barrier();
    const release = barrier();
    const delays: number[] = [];
    let builds = 0;
    const manager = new CommunicatorGenerationManager(
      generation(1, { stopped: true, takeoverDelayMs: 250 }),
      async (deadlineMs) => {
        builds += 1;
        expect(deadlineMs).toBe(6_000);
        return generation(2);
      },
      {
        nowMs: () => nowMs,
        async wait(delayMs, abort) {
          delays.push(delayMs);
          waiting.release();
          await release.reached;
          if (abort.aborted) return "aborted";
          nowMs += delayMs;
          return "completed";
        },
      },
      1_000,
    );
    const invocation = invoke(manager);
    await waiting.reached;
    expect({ builds, delays, current: Number(manager.current.fencingToken) }).toEqual({
      builds: 0,
      delays: [250],
      current: 1,
    });
    release.release();
    expect(await invocation).toBe("generation-2");
    expect(builds).toBe(1);
  });

  test("disposal aborts the grace delay and prevents successor construction", async () => {
    const delayStarted = barrier();
    let builds = 0;
    const manager = new CommunicatorGenerationManager(
      generation(1, { stopped: true, takeoverDelayMs: 500 }),
      async () => {
        builds += 1;
        return generation(2);
      },
      {
        nowMs: () => 1_000,
        wait: async (_delayMs, abort) => {
          delayStarted.release();
          if (abort.aborted) return "aborted";
          return new Promise((resolve) => {
            abort.addEventListener("abort", () => resolve("aborted"), { once: true });
          });
        },
      },
      1_000,
    );
    const invocation = invoke(manager);
    await delayStarted.reached;
    const disposal = manager.dispose();
    await expect(invocation).rejects.toThrow("host was disposed");
    await disposal;
    await manager.routeEvent({} as never);
    await manager.routeChat({} as never, {} as never);
    expect(builds).toBe(0);
  });

  test("caps the single grace delay at the startup deadline without acquiring", async () => {
    const delays: number[] = [];
    let builds = 0;
    const manager = new CommunicatorGenerationManager(
      generation(1, { stopped: true, takeoverDelayMs: 1_500 }),
      async () => {
        builds += 1;
        return generation(2);
      },
      {
        nowMs: () => 1_000,
        wait: async (delayMs) => {
          delays.push(delayMs);
          return "completed";
        },
      },
      1_000,
    );
    await expect(invoke(manager)).rejects.toThrow("exceeded its startup deadline");
    await expect(invoke(manager)).rejects.toThrow("exceeded its startup deadline");
    expect({ builds, delays, classification: manager.terminalState?.classification }).toEqual({
      builds: 0,
      delays: [1_000],
      classification: "ownership_unavailable",
    });
  });
});

describe("communicator generation terminal state", () => {
  test("rejects a takeover that does not advance the ownership epoch and never retries it", async () => {
    let builds = 0;
    let successorDisposals = 0;
    const manager = createManager(generation(7, { stopped: true }), async () => {
      builds += 1;
      return generation(7, { disposed: () => (successorDisposals += 1) });
    });
    await expect(invoke(manager)).rejects.toThrow("did not advance ownership");
    await expect(invoke(manager)).rejects.toThrow("did not advance ownership");
    expect({ builds, successorDisposals, state: manager.state }).toEqual({
      builds: 1,
      successorDisposals: 1,
      state: "failed",
    });
  });

  test("does not recover nonrecoverable stops and disposal wins a pending publication", async () => {
    const nonrecoverable = generation(1, { stopped: true });
    (nonrecoverable.lifecycle as { stopState?: unknown }).stopState = {
      cause: "storage_failure",
      reason: "shutdown",
      recoverable: false,
      diagnostic: "Communicator storage became unavailable.",
    };
    let builds = 0;
    const failed = createManager(nonrecoverable, async () => {
      builds += 1;
      return generation(2);
    });
    await expect(invoke(failed)).rejects.toThrow("storage became unavailable");
    await expect(invoke(failed)).rejects.toThrow("storage became unavailable");
    expect(failed.terminalState).toEqual({
      classification: "storage_failure",
      diagnostic: "Communicator storage became unavailable.",
    });
    expect(builds).toBe(0);

    const releaseBuild = barrier();
    const buildStarted = barrier();
    let successorDisposed = 0;
    const recovering = createManager(generation(10, { stopped: true }), async () => {
      buildStarted.release();
      await releaseBuild.reached;
      return generation(11, { disposed: () => (successorDisposed += 1) });
    });
    const waiting = invoke(recovering);
    await buildStarted.reached;
    const disposal = recovering.dispose();
    expect(recovering.state).toBe("disposed");
    releaseBuild.release();
    await expect(waiting).rejects.toThrow("disposed");
    await disposal;
    expect(successorDisposed).toBe(1);
    await expect(invoke(recovering)).rejects.toThrow("disposed");
  });

  test("retains one sanitized diagnostic when successor construction rejects", async () => {
    let builds = 0;
    const manager = createManager(generation(20, { stopped: true }), async () => {
      builds += 1;
      throw new Error("secret /workspace/private.sqlite3");
    });
    await expect(invoke(manager)).rejects.toThrow("generation recovery failed");
    await expect(invoke(manager)).rejects.toThrow("generation recovery failed");
    expect(JSON.stringify(manager.terminalState)).not.toContain("workspace");
    expect(manager.terminalState?.classification).toBe("recovery_failed");
    expect(builds).toBe(1);
  });

  test("preserves typed ownership contention across repeated calls", async () => {
    const manager = createManager(generation(21, { stopped: true }), async () => {
      throw new CommunicatorGenerationConstructionError("ownership_unavailable");
    });
    const diagnostic = "Communicator ownership is held by another backend.";
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    expect(manager.terminalState).toEqual({
      classification: "ownership_unavailable",
      diagnostic,
    });
  });

  test("keeps generic startup ownership loss neutral across repeated calls", async () => {
    const manager = createManager(generation(20, { stopped: true }), async () => {
      throw new CommunicatorGenerationConstructionError("ownership_lost");
    });
    const diagnostic = "Communicator ownership could not be established safely.";
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    expect(manager.terminalState).toEqual({ classification: "ownership_lost", diagnostic });
  });

  test("preserves typed storage failure across repeated calls", async () => {
    const manager = createManager(generation(22, { stopped: true }), async () => {
      throw new CommunicatorGenerationConstructionError("storage_failure");
    });
    const diagnostic = "Communicator storage became unavailable during recovery.";
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    expect(manager.terminalState).toEqual({ classification: "storage_failure", diagnostic });
  });

  test.each([
    ["storage_failure", "Communicator storage became unavailable."],
    ["contract_fault", "A communicator port contract failed."],
    ["workflow_fault", "A communicator workflow faulted."],
  ] as const)("repeats the sanitized %s stop diagnostic", async (cause, diagnostic) => {
    const stopped = generation(30, { stopped: true });
    (stopped.lifecycle as { stopState?: unknown }).stopState = {
      cause,
      reason: "shutdown",
      recoverable: false,
      diagnostic,
    };
    const manager = createManager(stopped, async () => generation(31));
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    expect(manager.terminalState?.diagnostic).toBe(diagnostic);
  });
});
