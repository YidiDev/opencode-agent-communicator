import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ActiveInvocationRegistry } from "../../../src/composition/active-invocations";
import { CommunicatorGenerationConstructionError } from "../../../src/composition/communicator-generation-errors";
import {
  type CommunicatorGenerationHandle,
  CommunicatorGenerationManager,
} from "../../../src/composition/communicator-generation-manager";

function generation(
  token: number,
  options: {
    stopped?: boolean;
    stopCause?: "ownership_lost" | "contract_fault";
    takeoverDelayMs?: number;
    takeoverDelayThrows?: boolean;
    disposed?: () => void;
  } = {},
): CommunicatorGenerationHandle {
  const invocations = new ActiveInvocationRegistry();
  const lifecycle: {
    fencingToken: number;
    status: "starting" | "ready" | "stopped";
    stopState:
      | {
          cause: "ownership_lost" | "contract_fault";
          reason: string;
          recoverable: boolean;
          diagnostic: string;
        }
      | undefined;
  } = {
    fencingToken: token,
    status: options.stopped ? "stopped" : "ready",
    stopState: options.stopped
      ? {
          cause: options.stopCause ?? "ownership_lost",
          reason: options.stopCause ?? "ownership_lost",
          recoverable: options.stopCause !== "contract_fault",
          diagnostic: "Communicator lifecycle is not ready.",
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
        execute: async () => `generation-${token}`,
      },
    } as never,
    event: async () => undefined,
    chat: async () => undefined,
    quiesce() {
      invocations.closeAdmission("ownership_lost");
    },
    async drainInvocations() {
      return invocations.drain();
    },
    settleInvocations: () => invocations.settled(),
    ownershipTakeoverDelayMs: () =>
      options.takeoverDelayThrows
        ? (() => {
            throw new Error("store down");
          })()
        : (options.takeoverDelayMs ?? 0),
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

describe("communicator generation successor contract-fault recovery", () => {
  test("recovers when the successor fails with a contract fault exactly on a free lease", async () => {
    let builds = 0;
    const manager = createManager(generation(1, { stopped: true }), async () => {
      builds += 1;
      if (builds === 1) throw new CommunicatorGenerationConstructionError("contract_fault");
      return generation(2);
    });
    expect(await invoke(manager)).toBe("generation-2");
    expect({ builds, state: manager.state, current: Number(manager.current.fencingToken) }).toEqual(
      {
        builds: 2,
        state: "active",
        current: 2,
      },
    );
  });

  test("recovers when a returned successor lifecycle fails with a contract fault on a free lease", async () => {
    let builds = 0;
    let disposals = 0;
    const manager = createManager(generation(1, { stopped: true }), async () => {
      builds += 1;
      if (builds === 1) {
        return generation(3, {
          stopped: true,
          stopCause: "contract_fault",
          disposed: () => {
            disposals += 1;
          },
        });
      }
      return generation(2);
    });
    expect(await invoke(manager)).toBe("generation-2");
    expect({ builds, disposals, state: manager.state }).toEqual({
      builds: 2,
      disposals: 1,
      state: "active",
    });
  });

  test("terminates when the retried successor also fails with a contract fault", async () => {
    let builds = 0;
    const manager = createManager(generation(1, { stopped: true }), async () => {
      builds += 1;
      throw new CommunicatorGenerationConstructionError("contract_fault");
    });
    await expect(invoke(manager)).rejects.toThrow("A communicator port contract failed.");
    expect({ builds, state: manager.state }).toEqual({ builds: 2, state: "failed" });
  });

  test("does not retry a contract fault while a competitor still holds the lease", async () => {
    let builds = 0;
    const manager = new CommunicatorGenerationManager(
      generation(1, { stopped: true, takeoverDelayMs: 500 }),
      async () => {
        builds += 1;
        throw new CommunicatorGenerationConstructionError("contract_fault");
      },
      immediateDelay,
      1_000,
    );
    await expect(invoke(manager)).rejects.toThrow("A communicator port contract failed.");
    expect({ builds, state: manager.state }).toEqual({ builds: 1, state: "failed" });
  });

  test("does not retry a successor failure that is not a contract fault", async () => {
    let builds = 0;
    const manager = createManager(generation(1, { stopped: true }), async () => {
      builds += 1;
      throw new CommunicatorGenerationConstructionError("storage_failure");
    });
    await expect(invoke(manager)).rejects.toThrow("during recovery");
    expect({ builds, state: manager.state }).toEqual({ builds: 1, state: "failed" });
  });

  test("fails closed when the expired-lease store read faults", async () => {
    const manager = createManager(
      generation(1, { stopped: true, stopCause: "contract_fault", takeoverDelayThrows: true }),
      async () => generation(2),
    );
    await expect(invoke(manager)).rejects.toThrow("Communicator storage became unavailable.");
    expect(manager.state).toBe("failed");
  });
});
