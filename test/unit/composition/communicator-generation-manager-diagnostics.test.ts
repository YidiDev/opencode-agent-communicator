import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ActiveInvocationRegistry } from "../../../src/composition/active-invocations";
import { CommunicatorGenerationConstructionError } from "../../../src/composition/communicator-generation-errors";
import {
  type CommunicatorGenerationHandle,
  CommunicatorGenerationManager,
} from "../../../src/composition/communicator-generation-manager";

function generation(token: number, stopped = false): CommunicatorGenerationHandle {
  const invocations = new ActiveInvocationRegistry();
  const lifecycle = {
    fencingToken: token,
    status: stopped ? "stopped" : "ready",
    stopState: stopped
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
        args: z.object({}),
        execute: async () => `generation-${token}`,
      },
    } as never,
    event: async () => undefined,
    chat: async () => undefined,
    quiesce: () => invocations.closeAdmission(),
    drainInvocations: () => invocations.drain(),
    settleInvocations: () => invocations.settled(),
    ownershipTakeoverDelayMs: () => 0,
    shutdownUnpublished: () => invocations.closeAdmission(),
    disposeResources: async () => undefined,
  };
}

function manager(
  initial: CommunicatorGenerationHandle,
  create: () => Promise<CommunicatorGenerationHandle>,
): CommunicatorGenerationManager {
  return new CommunicatorGenerationManager(
    initial,
    create,
    { nowMs: () => 1_000, wait: async () => "completed" },
    1_000,
  );
}

function invoke(value: CommunicatorGenerationManager): Promise<string> {
  return value.invoke(
    "session_list",
    new AbortController().signal,
    (contract, context) => contract.execute({}, context),
    { sessionID: "session", messageID: "message", ask: async () => undefined },
  );
}

describe("communicator generation typed terminal diagnostics", () => {
  test.each([
    ["ownership_unavailable", "Communicator ownership is held by another backend."],
    ["ownership_lost", "Communicator ownership could not be established safely."],
    ["storage_failure", "Communicator storage became unavailable during recovery."],
  ] as const)("preserves typed %s construction failure", async (classification, diagnostic) => {
    const value = manager(generation(20, true), async () => {
      throw new CommunicatorGenerationConstructionError(classification);
    });
    await expect(invoke(value)).rejects.toThrow(diagnostic);
    await expect(invoke(value)).rejects.toThrow(diagnostic);
    expect(value.terminalState).toEqual({ classification, diagnostic });
  });

  test.each([
    ["storage_failure", "Communicator storage became unavailable."],
    ["contract_fault", "A communicator port contract failed."],
    ["workflow_fault", "A communicator workflow faulted."],
  ] as const)("repeats the sanitized %s stop diagnostic", async (cause, diagnostic) => {
    const stopped = generation(30, true);
    (stopped.lifecycle as { stopState?: unknown }).stopState = {
      cause,
      reason: "shutdown",
      recoverable: false,
      diagnostic,
    };
    const value = manager(stopped, async () => generation(31));
    await expect(invoke(value)).rejects.toThrow(diagnostic);
    await expect(invoke(value)).rejects.toThrow(diagnostic);
    expect(value.terminalState?.diagnostic).toBe(diagnostic);
  });
});
