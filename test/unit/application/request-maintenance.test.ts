import { expect, test } from "bun:test";

import {
  drainRequestMaintenance,
  type RequestMaintenancePorts,
  requestStartupResultExpiryHardBudget,
} from "../../../src/application/request-maintenance";
import type { ExpiredAnsweredOrReachedRequestMetadata } from "../../../src/application/request-ports";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import { requestLimits } from "../../../src/domain/request-constants";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("maintenance"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const fencingToken = 9 as FencingToken;

function expiredResult(seed: number): ExpiredAnsweredOrReachedRequestMetadata {
  const hex = seed.toString(16).padStart(32, "0");
  const resolvedAtMs = 2;
  const resultExpiresAtMs = resolvedAtMs + requestLimits.resultRetentionMs;
  return {
    id: value(validateRequestId(`req_${hex}`)),
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId: value(validateNativeMessageId(`msg_${hex}`)),
    kind: "wait",
    resolutionState: "reached",
    deliveryState: "prepared",
    resultState: "expired",
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: resultExpiresAtMs,
    deadlineAtMs: 100,
    resolvedAtMs,
    resultAvailableAtMs: resolvedAtMs,
    resultExpiresAtMs,
    resultExpiredAtMs: resultExpiresAtMs,
  } as ExpiredAnsweredOrReachedRequestMetadata;
}

test("recurring maintenance expires 1025 results and returns partial retention at its 1024 budget", async () => {
  const due = Array.from({ length: 1_025 }, (_, index) => expiredResult(index + 1));
  const resultLimits: number[] = [];
  const retentionLimits: number[] = [];
  let deleted = 0;
  const ports: RequestMaintenancePorts = {
    resultRetention: {
      async expireAvailableResults({ limit }) {
        resultLimits.push(limit);
        return { ok: true, requests: due.splice(0, limit) };
      },
    },
    requestRetention: {
      async collectRequestRetention({ limit }) {
        retentionLimits.push(limit);
        const count = Math.min(limit, 1_025 - deleted);
        deleted += count;
        return { ok: true, deletedRequests: count, deletedRateEvents: count };
      },
    },
  };
  expect(await drainRequestMaintenance({ ports, fencingToken, workspaceKey })).toEqual({
    ok: true,
    expiredResults: 1_025,
    deletedRequests: 1_024,
    deletedRateEvents: 1_024,
  });
  expect(resultLimits).toHaveLength(11);
  expect(resultLimits.every((limit) => limit === 100)).toBe(true);
  expect(retentionLimits).toHaveLength(11);
  expect(retentionLimits.at(-1)).toBe(24);
});

test("startup result expiry drains the immutable 4096-row workspace ceiling", async () => {
  let expired = 0;
  const limits: number[] = [];
  const ports: RequestMaintenancePorts = {
    resultRetention: {
      async expireAvailableResults({ limit }) {
        limits.push(limit);
        const count = Math.min(limit, requestStartupResultExpiryHardBudget - expired);
        const requests = Array.from({ length: count }, (_, index) =>
          expiredResult(expired + index + 1),
        );
        expired += count;
        return { ok: true, requests };
      },
    },
    requestRetention: {
      async collectRequestRetention() {
        return { ok: true, deletedRequests: 0, deletedRateEvents: 0 };
      },
    },
  };
  expect(
    await drainRequestMaintenance({
      ports,
      fencingToken,
      workspaceKey,
      resultExpiryHardBudget: requestStartupResultExpiryHardBudget,
    }),
  ).toMatchObject({ ok: true, expiredResults: 4_096 });
  expect(limits.at(-1)).toBe(96);
  expect(limits).not.toContain(0);
});

test("recurring result expiry supports the 4096 ceiling and continues retention", async () => {
  let expired = 0;
  const limits: number[] = [];
  let retentionCalls = 0;
  const result = await drainRequestMaintenance({
    fencingToken,
    workspaceKey,
    ports: {
      resultRetention: {
        async expireAvailableResults({ limit }) {
          limits.push(limit);
          const count = Math.min(limit, 4_096 - expired);
          const requests = Array.from({ length: count }, (_, index) =>
            expiredResult(expired + index + 1),
          );
          expired += count;
          return { ok: true, requests };
        },
      },
      requestRetention: {
        async collectRequestRetention() {
          retentionCalls++;
          return { ok: true, deletedRequests: 0, deletedRateEvents: 0 };
        },
      },
    },
  });
  expect(result).toMatchObject({ ok: true, expiredResults: 4_096 });
  expect(retentionCalls).toBe(1);
  expect(limits.at(-1)).toBe(96);
  expect(limits).not.toContain(0);
});

test("request maintenance maps interruption, failures, throws, and malformed counts", async () => {
  const emptyResults = {
    expireAvailableResults: async () => ({ ok: true as const, requests: [] }),
  };
  const noRetention = {
    collectRequestRetention: async () => ({
      ok: true as const,
      deletedRequests: 0,
      deletedRateEvents: 0,
    }),
  };
  const base = { fencingToken, workspaceKey };
  expect(
    await drainRequestMaintenance({
      ...base,
      ports: { resultRetention: emptyResults, requestRetention: noRetention },
      shouldStop: () => true,
    }),
  ).toEqual({ ok: false, code: "ownership_lost" });
  for (const resultRetention of [
    {
      expireAvailableResults: async () => ({ ok: false as const, code: "ownership_lost" as const }),
    },
    { expireAvailableResults: async () => ({ ok: false as const, code: "future" }) },
    { expireAvailableResults: async () => ({ ok: true as const, requests: "bad" }) },
    {
      expireAvailableResults: async () => {
        throw new Error("result store");
      },
    },
  ]) {
    expect(
      (
        await drainRequestMaintenance({
          ...base,
          ports: { resultRetention, requestRetention: noRetention } as never,
        })
      ).ok,
    ).toBe(false);
  }
  for (const requestRetention of [
    {
      collectRequestRetention: async () => ({
        ok: false as const,
        code: "ownership_lost" as const,
      }),
    },
    { collectRequestRetention: async () => ({ ok: false as const, code: "future" }) },
    {
      collectRequestRetention: async () => ({
        ok: true as const,
        deletedRequests: 101,
        deletedRateEvents: -1,
      }),
    },
    {
      collectRequestRetention: async () => {
        throw new Error("retention store");
      },
    },
  ]) {
    expect(
      (
        await drainRequestMaintenance({
          ...base,
          ports: { resultRetention: emptyResults, requestRetention } as never,
        })
      ).ok,
    ).toBe(false);
  }
});
