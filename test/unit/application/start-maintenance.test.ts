import { describe, expect, test } from "bun:test";

import type {
  StartLimits,
  StartOperationPersistencePort,
} from "../../../src/application/session-start-ports";
import { drainStartMaintenance } from "../../../src/application/start-maintenance";
import { OwnershipLostFault } from "../../../src/domain/ownership";

const limits: StartLimits = {
  managedSessionsPerWorkspace: 64,
  unresolvedProvenancePerWorkspace: 16,
  operationsPerWorkspace: 4_096,
  payloadBytesPerWorkspace: 8 * 1_024 * 1_024,
  startsPerSourceWindow: 5,
  startsPerWorkspaceWindow: 25,
  rateWindowMs: 60_000,
  terminalRetentionMs: 86_400_000,
};

function invoke(
  collectRetention: StartOperationPersistencePort["collectRetention"],
  options: { readonly shouldStop?: () => boolean; readonly abort?: AbortSignal } = {},
) {
  return drainStartMaintenance({
    starts: { collectRetention } as StartOperationPersistencePort,
    limits,
    fencingToken: 1 as never,
    workspaceKey: "maintenance" as never,
    nowMs: 100_000_000,
    ...options,
  });
}

describe("start maintenance boundaries", () => {
  test("drains independent operation and rate batches with configured ages", async () => {
    const calls: unknown[] = [];
    let invocation = 0;
    const result = await invoke(async (input) => {
      calls.push(input);
      invocation += 1;
      return invocation === 1
        ? { ok: true, deletedOperations: 100, deletedRateEvents: 100 }
        : { ok: true, deletedOperations: 2, deletedRateEvents: 0 };
    });
    expect(result).toEqual({
      ok: true,
      deletedOperations: 102,
      deletedRateEvents: 100,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      terminalRetentionMs: limits.terminalRetentionMs,
      rateRetentionMs: limits.rateWindowMs,
      limit: 100,
    });
  });

  test("stops on ownership cancellation and maps rejected persistence", async () => {
    expect(
      await invoke(async () => ({ ok: true, deletedOperations: 0, deletedRateEvents: 0 }), {
        shouldStop: () => true,
      }),
    ).toEqual({ ok: false, code: "ownership_lost" });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await invoke(async () => ({ ok: true, deletedOperations: 0, deletedRateEvents: 0 }), {
        abort: aborted.signal,
      }),
    ).toEqual({ ok: false, code: "ownership_lost" });
    for (const [cause, code] of [
      [new OwnershipLostFault("lost"), "ownership_lost"],
      [new Error("disk"), "storage_unavailable"],
    ] as const) {
      expect(
        await invoke(async () => {
          throw cause;
        }),
      ).toEqual({ ok: false, code });
    }
  });

  test("fails closed on malformed adapter results", async () => {
    for (const raw of [
      undefined,
      {},
      { ok: false },
      { ok: true },
      { ok: true, deletedOperations: -1, deletedRateEvents: 0 },
      { ok: true, deletedOperations: 0.5, deletedRateEvents: 0 },
      { ok: true, deletedOperations: 0, deletedRateEvents: -1 },
      { ok: true, deletedOperations: 0, deletedRateEvents: 101 },
      { ok: true, deletedOperations: 101, deletedRateEvents: 0 },
      { ok: true, deletedOperations: 0, deletedRateEvents: 0, extra: true },
      { ok: false, code: "future" },
      { ok: false, code: "state_conflict", extra: true },
    ]) {
      expect(await invoke(async () => raw as never)).toEqual({ ok: false, code: "contract" });
    }
    expect(await invoke(async () => ({ ok: false, code: "state_conflict" }))).toEqual({
      ok: false,
      code: "state_conflict",
    });
  });
});
