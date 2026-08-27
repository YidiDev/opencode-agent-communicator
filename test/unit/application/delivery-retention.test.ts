import { expect, test } from "bun:test";

import {
  deliveryRetentionCycleHardBudget,
  drainDeliveryRetention,
} from "../../../src/application/delivery-retention";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("workspace:delivery-retention");
if (!workspace.ok) throw new Error("invalid workspace fixture");
const fencingToken = 3 as FencingToken;

test("delivery retention uses bounded batches and a hard cycle budget", async () => {
  const limits: number[] = [];
  const result = await drainDeliveryRetention({
    fencingToken,
    workspaceKey: workspace.value,
    persistence: {
      async garbageCollectMetadata({ limit }) {
        limits.push(limit);
        return { ok: true, deletedDeliveries: limit, deletedRateEvents: limit };
      },
    },
  });
  expect(result).toEqual({
    ok: true,
    deletedDeliveries: deliveryRetentionCycleHardBudget,
    deletedRateEvents: deliveryRetentionCycleHardBudget,
  });
  expect(limits).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 24]);
});

test("delivery retention stops after a partial pair and validates every runtime result", async () => {
  expect(
    await drainDeliveryRetention({
      fencingToken,
      workspaceKey: workspace.value,
      persistence: {
        garbageCollectMetadata: async () => ({
          ok: true,
          deletedDeliveries: 2,
          deletedRateEvents: 3,
        }),
      },
    }),
  ).toEqual({ ok: true, deletedDeliveries: 2, deletedRateEvents: 3 });

  const accessor = Object.defineProperty({}, "ok", {
    enumerable: true,
    get: () => true,
  });
  for (const returned of [
    null,
    accessor,
    { ok: false, code: "storage_unavailable" },
    { ok: true, deletedDeliveries: 101, deletedRateEvents: 0 },
    { ok: true, deletedDeliveries: 0, deletedRateEvents: Number.NaN },
    { ok: true, deletedDeliveries: 0, deletedRateEvents: 0, extra: true },
  ]) {
    expect(
      await drainDeliveryRetention({
        fencingToken,
        workspaceKey: workspace.value,
        persistence: { garbageCollectMetadata: async () => returned },
      }),
    ).toEqual({ ok: false, code: "contract" });
  }
});

test("delivery retention classifies abort, lifecycle fencing, ownership, and storage faults", async () => {
  const base = { fencingToken, workspaceKey: workspace.value };
  expect(
    await drainDeliveryRetention({
      ...base,
      shouldStop: () => true,
      persistence: { garbageCollectMetadata: async () => new Promise(() => undefined) },
    }),
  ).toEqual({ ok: false, code: "ownership_lost" });

  const abort = new AbortController();
  abort.abort();
  expect(
    await drainDeliveryRetention({
      ...base,
      abort: abort.signal,
      persistence: { garbageCollectMetadata: async () => new Promise(() => undefined) },
    }),
  ).toEqual({ ok: false, code: "ownership_lost" });

  for (const cause of [new OwnershipLostFault("lost"), new Error("disk")]) {
    expect(
      await drainDeliveryRetention({
        ...base,
        persistence: {
          garbageCollectMetadata: async () => {
            throw cause;
          },
        },
      }),
    ).toEqual({
      ok: false,
      code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    });
  }
  for (const hardBudget of [0, 1.5, deliveryRetentionCycleHardBudget + 1]) {
    expect(
      await drainDeliveryRetention({
        ...base,
        hardBudget,
        persistence: { garbageCollectMetadata: async () => ({}) },
      }),
    ).toEqual({ ok: false, code: "contract" });
  }
});
