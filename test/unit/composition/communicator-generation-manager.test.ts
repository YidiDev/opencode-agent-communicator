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
    unpublishedShutdown?: () => void;
    event?: () => void;
    chat?: () => void;
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
    event: async () => options.event?.(),
    chat: async () => options.chat?.(),
    quiesce() {
      invocations.closeAdmission("ownership_lost");
    },
    async drainInvocations() {
      if (options.drain) return options.drain;
      return invocations.drain();
    },
    settleInvocations: () => options.settlement ?? invocations.settled(),
    ownershipTakeoverDelayMs: () => options.takeoverDelayMs ?? 0,
    shutdownUnpublished() {
      if (lifecycle.status === "ready") {
        lifecycle.status = "stopped";
        lifecycle.stopState = {
          cause: "contract_fault",
          reason: "shutdown",
          recoverable: false,
          diagnostic: "A communicator port contract failed.",
        };
      }
      options.unpublishedShutdown?.();
      invocations.closeAdmission("unpublished_shutdown");
    },
    async disposeResources() {
      options.disposed?.();
    },
  };
}

const immediateDelay = {
  nowMs: () => 1_000,
  wait: async () => "completed" as const,
};

const invalidRecoveryClocks: ReadonlyArray<readonly [string, () => number]> = [
  [
    "throws",
    () => {
      throw new Error("clock detail");
    },
  ],
  ["returns NaN", () => Number.NaN],
  ["returns a negative value", () => -1],
  ["returns an unsafe value", () => Number.MAX_SAFE_INTEGER + 1],
];

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

  test("re-admits once on the successor when stop lands before the callback begins", async () => {
    let staleExecutions = 0;
    let successorExecutions = 0;
    const stale = generation(1, {
      execute: async () => {
        staleExecutions += 1;
        return "stale";
      },
    });
    const successor = generation(2, {
      execute: async () => {
        successorExecutions += 1;
        return "successor";
      },
    });
    const manager = createManager(stale, async () => successor);

    const invocation = invoke(manager);
    queueMicrotask(() => {
      (stale.lifecycle as { status: string; stopState?: unknown }).status = "stopped";
      (stale.lifecycle as { stopState?: unknown }).stopState = {
        cause: "ownership_lost",
        reason: "ownership_lost",
        recoverable: true,
        diagnostic: "Communicator ownership ended.",
      };
      stale.quiesce();
    });

    expect(await invocation).toBe("successor");
    expect({ staleExecutions, successorExecutions }).toEqual({
      staleExecutions: 0,
      successorExecutions: 1,
    });
  });

  test("does not recover for an already cancelled caller", async () => {
    let builds = 0;
    const manager = createManager(generation(1, { stopped: true }), async () => {
      builds += 1;
      return generation(2);
    });
    const caller = new AbortController();
    caller.abort("cancelled");

    await expect(
      manager.invoke(
        "session_list",
        caller.signal,
        (contract, context) => contract.execute({}, context),
        { sessionID: "session", messageID: "message", ask: async () => undefined },
      ),
    ).rejects.toThrow("cancelled");
    expect({ builds, state: manager.state }).toEqual({ builds: 0, state: "active" });
  });

  test("bounds repeated pre-callback admission closure to one handoff", async () => {
    const stale = generation(1);
    const disposed = barrier();
    let shutdowns = 0;
    let eventCalls = 0;
    let chatCalls = 0;
    const successor = generation(2, {
      unpublishedShutdown: () => {
        shutdowns += 1;
      },
      disposed: disposed.release,
      event: () => {
        eventCalls += 1;
      },
      chat: () => {
        chatCalls += 1;
      },
    });
    let builds = 0;
    let callbacks = 0;
    successor.invocations.runWithAdmission = async () => ({ admitted: false, reason: "closed" });
    const manager = createManager(stale, async () => {
      builds += 1;
      return successor;
    });

    const invocation = manager.invoke(
      "session_list",
      new AbortController().signal,
      async () => {
        callbacks += 1;
        return "unexpected";
      },
      { sessionID: "session", messageID: "message", ask: async () => undefined },
    );
    queueMicrotask(() => {
      (stale.lifecycle as { status: string; stopState?: unknown }).status = "stopped";
      (stale.lifecycle as { stopState?: unknown }).stopState = {
        cause: "ownership_lost",
        recoverable: true,
        diagnostic: "Communicator ownership ended.",
      };
      stale.quiesce();
    });

    const diagnostic = "Communicator invocation admission handoff failed.";
    await expect(invocation).rejects.toThrow(diagnostic);
    expect(shutdowns).toBe(1);
    expect(successor.lifecycle.status).toBe("stopped");
    await manager.routeEvent({} as never);
    await manager.routeChat({} as never, {} as never);
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    await disposed.reached;
    expect({
      builds,
      callbacks,
      eventCalls,
      chatCalls,
      state: manager.state,
      terminal: manager.terminalState,
    }).toEqual({
      builds: 1,
      callbacks: 0,
      eventCalls: 0,
      chatCalls: 0,
      state: "failed",
      terminal: { classification: "contract_fault", diagnostic },
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
});

describe("communicator generation recovery boundary failures", () => {
  test.each(invalidRecoveryClocks)(
    "classifies a clock that %s before waiting as a contract fault",
    async (_name, bad) => {
      let reads = 0;
      let waits = 0;
      let builds = 0;
      const manager = new CommunicatorGenerationManager(
        generation(1, { stopped: true, takeoverDelayMs: 10 }),
        async () => {
          builds += 1;
          return generation(2);
        },
        {
          nowMs: () => (++reads === 1 ? 1_000 : bad()),
          wait: async () => {
            waits += 1;
            return "completed";
          },
        },
        1_000,
      );
      await expect(invoke(manager)).rejects.toThrow("timing is invalid");
      await expect(invoke(manager)).rejects.toThrow("timing is invalid");
      expect({ reads, waits, builds, terminal: manager.terminalState?.classification }).toEqual({
        reads: 2,
        waits: 0,
        builds: 0,
        terminal: "contract_fault",
      });
    },
  );

  test.each(invalidRecoveryClocks)(
    "classifies a clock that %s after waiting as a contract fault",
    async (_name, bad) => {
      let reads = 0;
      let waits = 0;
      let builds = 0;
      const manager = new CommunicatorGenerationManager(
        generation(1, { stopped: true, takeoverDelayMs: 10 }),
        async () => {
          builds += 1;
          return generation(2);
        },
        {
          nowMs: () => {
            reads += 1;
            return reads < 3 ? 1_000 : bad();
          },
          wait: async () => {
            waits += 1;
            return "completed";
          },
        },
        1_000,
      );
      await expect(invoke(manager)).rejects.toThrow("timing is invalid");
      await expect(invoke(manager)).rejects.toThrow("timing is invalid");
      expect({ reads, waits, builds, terminal: manager.terminalState?.classification }).toEqual({
        reads: 3,
        waits: 1,
        builds: 0,
        terminal: "contract_fault",
      });
    },
  );

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

  test("disposes stale resources when takeover inspection fails and keeps the causal type", async () => {
    let disposals = 0;
    const stale = generation(1, {
      stopped: true,
      disposed: () => {
        disposals += 1;
        throw new Error("cleanup detail");
      },
    });
    stale.ownershipTakeoverDelayMs = () => {
      throw new CommunicatorGenerationConstructionError("storage_failure");
    };
    let builds = 0;
    const manager = createManager(stale, async () => {
      builds += 1;
      return generation(2);
    });

    await expect(invoke(manager)).rejects.toThrow("storage became unavailable");
    await expect(invoke(manager)).rejects.toThrow("storage became unavailable");
    expect({ disposals, builds, terminal: manager.terminalState?.classification }).toEqual({
      disposals: 1,
      builds: 0,
      terminal: "storage_failure",
    });
  });

  test("uses a stale cleanup failure when it is the only recovery failure", async () => {
    let builds = 0;
    const manager = createManager(
      generation(1, {
        stopped: true,
        disposed: () => {
          throw new Error("cleanup detail");
        },
      }),
      async () => {
        builds += 1;
        return generation(2);
      },
    );
    await expect(invoke(manager)).rejects.toThrow("generation recovery failed");
    expect({ builds, terminal: manager.terminalState?.classification }).toEqual({
      builds: 0,
      terminal: "recovery_failed",
    });
  });

  test("makes a throwing recovery clock an immutable contract fault without building", async () => {
    let reads = 0;
    let builds = 0;
    const manager = new CommunicatorGenerationManager(
      generation(1, { stopped: true }),
      async () => {
        builds += 1;
        return generation(2);
      },
      {
        nowMs: () => {
          reads += 1;
          throw new Error("clock secret");
        },
        wait: async () => "completed",
      },
      1_000,
    );
    const diagnostic = "Communicator recovery timing is invalid.";
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    await expect(invoke(manager)).rejects.toThrow(diagnostic);
    expect({ reads, builds, terminal: manager.terminalState }).toEqual({
      reads: 1,
      builds: 0,
      terminal: { classification: "contract_fault", diagnostic },
    });
  });
});

describe("communicator generation terminal state", () => {
  test("rejects a takeover that does not advance the ownership epoch and never retries it", async () => {
    let builds = 0;
    let successorDisposals = 0;
    const cleanupOrder: string[] = [];
    const manager = createManager(generation(7, { stopped: true }), async () => {
      builds += 1;
      return generation(7, {
        drain: "timed_out",
        settlement: Promise.resolve(),
        unpublishedShutdown: () => {
          cleanupOrder.push("lifecycle-scheduler-runtime-stop");
          throw new Error("shutdown cleanup detail");
        },
        disposed: () => {
          successorDisposals += 1;
          cleanupOrder.push("store-close");
        },
      });
    });
    await expect(invoke(manager)).rejects.toThrow("did not advance ownership");
    await expect(invoke(manager)).rejects.toThrow("did not advance ownership");
    expect({ builds, successorDisposals, state: manager.state }).toEqual({
      builds: 1,
      successorDisposals: 1,
      state: "failed",
    });
    expect(cleanupOrder).toEqual(["lifecycle-scheduler-runtime-stop", "store-close"]);
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

  test("disposes a stopped higher-token successor and never attempts another replacement", async () => {
    let builds = 0;
    let disposals = 0;
    const cleanupOrder: string[] = [];
    const successor = generation(2, {
      stopped: true,
      unpublishedShutdown: () => cleanupOrder.push("terminal-stop-confirmed"),
      disposed: () => {
        disposals += 1;
        cleanupOrder.push("store-close");
      },
    });
    (successor.lifecycle as { stopState?: unknown }).stopState = {
      cause: "workflow_fault",
      reason: "shutdown",
      recoverable: false,
      diagnostic: "A communicator workflow faulted.",
    };
    const manager = createManager(generation(1, { stopped: true }), async () => {
      builds += 1;
      return successor;
    });
    await expect(invoke(manager)).rejects.toThrow("workflow faulted");
    await expect(invoke(manager)).rejects.toThrow("workflow faulted");
    expect({ builds, disposals, state: manager.state, terminal: manager.terminalState }).toEqual({
      builds: 1,
      disposals: 1,
      state: "failed",
      terminal: {
        classification: "workflow_fault",
        diagnostic: "A communicator workflow faulted.",
      },
    });
    expect(cleanupOrder).toEqual(["terminal-stop-confirmed", "store-close"]);
  });

  test("rejects a successor that stops at the final publication boundary", async () => {
    let builds = 0;
    let disposals = 0;
    const successor = generation(2, {
      disposed: () => {
        disposals += 1;
      },
    });
    Object.defineProperty(successor, "fencingToken", {
      configurable: true,
      get() {
        (successor.lifecycle as { status: string; stopState?: unknown }).status = "stopped";
        (successor.lifecycle as { stopState?: unknown }).stopState = {
          cause: "workflow_fault",
          reason: "shutdown",
          recoverable: false,
          diagnostic: "A communicator workflow faulted.",
        };
        return 2;
      },
    });
    const manager = createManager(generation(1, { stopped: true }), async () => {
      builds += 1;
      return successor;
    });

    await expect(invoke(manager)).rejects.toThrow("workflow faulted");
    await expect(invoke(manager)).rejects.toThrow("workflow faulted");
    expect({ builds, disposals, terminal: manager.terminalState?.classification }).toEqual({
      builds: 1,
      disposals: 1,
      terminal: "workflow_fault",
    });
  });
});
