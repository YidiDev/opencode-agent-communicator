import { describe, expect, test } from "bun:test";

import {
  classifyStaleSessionRequests,
  expireDueSessionRequests,
  recoverPreparedSessionRequests,
} from "../../../src/application/recover-session-requests";
import type { SessionRequestRecoveryPorts } from "../../../src/application/request-ports";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import type { PendingRequestMetadata, RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid ceiling fixture");
  return result.value;
}

const token = valid(validateFencingToken(43));

async function requests(count: number, state: "prepared" | "submitting") {
  const base = (await requestFixture(token, 1_000)).request;
  return Array.from({ length: count }, (_, offset): RequestMetadata => {
    const index = offset + 1;
    const suffix = index.toString(16).padStart(32, "0");
    const prepared = {
      ...base,
      id: valid(validateRequestId(`req_${suffix}`)),
      nativeMessageId: valid(validateNativeMessageId(`msg_${suffix}`)),
      createdAtMs: index,
      updatedAtMs: index,
      deadlineAtMs: 40_000 + index,
    };
    if (state === "prepared") return prepared;
    const submitting = {
      ...prepared,
      deliveryState: "submitting" as const,
      submittedAtMs: 2_000 + index,
      updatedAtMs: 2_000 + index,
    };
    if (index !== 1) return submitting;
    const { payloadSha256: _payloadSha256, ...terminal } = submitting;
    return {
      ...terminal,
      resolutionState: "cancelled",
      resolvedAtMs: index + 1,
    };
  });
}

function input(workspaceKey: RequestMetadata["workspaceKey"]) {
  const signal = new AbortController().signal;
  return {
    workspaceKey,
    fencingToken: token,
    startupBarrier: { established: true as const, fencingToken: token },
    abort: signal,
    effectSignal: signal,
    deadlineMs: 99_000,
    limit: 100,
  };
}

describe("request startup exact recovery ceilings", () => {
  for (const count of [4_096, 4_097]) {
    test(`stale traversal ${count === 4_096 ? "accepts the exact ceiling including terminal cancelled work" : "rejects the exact residual probe"}`, async () => {
      const rows = await requests(count, "submitting");
      let offset = 0;
      const limits: number[] = [];
      const ports = {
        requests: {
          async listRecoverableRequests(query: { limit: number; startupBarrier?: unknown }) {
            limits.push(query.limit);
            expect(query.startupBarrier).toBeDefined();
            const page = rows.slice(offset, offset + query.limit);
            offset += page.length;
            return page;
          },
          async completeDelivery(query: { requestId: string }) {
            const original = rows.find((request) => request.id === query.requestId);
            if (!original) throw new Error("missing request");
            return {
              ok: true as const,
              request: {
                ...original,
                deliveryState: "delivery_unknown" as const,
                deliveryUnknownAtMs: 50_000,
                updatedAtMs: 50_000,
              },
            };
          },
        },
        ownership: { isCurrent: async () => true },
        notifications: { notifyTerminal: () => undefined },
        clock: { nowMs: () => 1 },
      } as unknown as SessionRequestRecoveryPorts;
      const workspaceKey = rows[0]?.workspaceKey;
      if (!workspaceKey) throw new Error("missing stale workspace");
      const result = await classifyStaleSessionRequests(ports, input(workspaceKey));
      expect(result.ok).toBe(count === 4_096);
      expect(limits.at(-1)).toBe(1);
      expect(limits).not.toContain(0);
    });
  }

  for (const count of [1_024, 1_025]) {
    test(`prepared traversal ${count === 1_024 ? "accepts the exact ceiling" : "rejects a residual row"}`, async () => {
      const rows = await requests(count, "prepared");
      const limits: number[] = [];
      const ports = {
        requests: {
          async listRecoverableRequests(query: {
            limit: number;
            cursor?: { createdAtMs: number; id: string };
          }) {
            limits.push(query.limit);
            const cursor = query.cursor;
            const offset = cursor
              ? rows.findIndex(
                  (request) =>
                    request.createdAtMs > cursor.createdAtMs ||
                    (request.createdAtMs === cursor.createdAtMs && request.id > cursor.id),
                )
              : 0;
            return offset < 0 ? [] : rows.slice(offset, offset + query.limit);
          },
        },
        activity: {
          async observeRequestParticipants() {
            return { sourceVisible: true, targetVisible: true, targetStatus: "idle" as const };
          },
        },
        ownership: { isCurrent: async () => true },
        notifications: { notifyTerminal: () => undefined },
        nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
        clock: { nowMs: () => 1 },
      } as unknown as SessionRequestRecoveryPorts;
      const workspaceKey = rows[0]?.workspaceKey;
      if (!workspaceKey) throw new Error("missing prepared workspace");
      const result = await recoverPreparedSessionRequests(ports, input(workspaceKey));
      expect(result.ok).toBe(count === 1_024);
      expect(limits.at(-1)).toBe(1);
      expect(limits).not.toContain(0);
    });
  }

  for (const residual of ["none", "future", "due"] as const) {
    test(`due expiry proves exact ceiling residual schedule: ${residual}`, async () => {
      const rows = await requests(1_024, "prepared");
      const due = rows.map((request) => {
        const pending = request as PendingRequestMetadata;
        const { payloadSha256: _payloadSha256, ...history } = pending;
        return {
          ...history,
          resolutionState: "deadline_expired" as const,
          resolvedAtMs: request.deadlineAtMs,
          updatedAtMs: request.deadlineAtMs,
        };
      });
      let expiryCalls = 0;
      let scheduleCalls = 0;
      const ports = {
        requests: {
          async expireDueRequests(query: { limit: number }) {
            expiryCalls++;
            return { ok: true as const, requests: due.splice(0, query.limit) };
          },
          async readNextPendingDeadline() {
            scheduleCalls++;
            return {
              storeObservedAtMs: 50_000,
              maximumSleepMs: 10,
              ...(residual === "none"
                ? {}
                : { nextDeadlineAtMs: residual === "future" ? 50_001 : 50_000 }),
            };
          },
        },
        ownership: { isCurrent: async () => true },
        notifications: { notifyTerminal: () => undefined },
        clock: { nowMs: () => 1 },
      } as unknown as SessionRequestRecoveryPorts;
      const workspaceKey = rows[0]?.workspaceKey;
      if (!workspaceKey) throw new Error("missing expiry workspace");
      const result = await expireDueSessionRequests(ports, input(workspaceKey));
      expect(result.ok).toBe(residual !== "due");
      if (!result.ok) expect(result.error.code).toBe("storage_unavailable");
      expect(expiryCalls).toBe(11);
      expect(scheduleCalls).toBe(1);
    });
  }

  test("due expiry exact-ceiling schedule is abort bounded and maps malformed or rejected reads", async () => {
    for (const mode of ["malformed", "throw", "ownership", "abort"] as const) {
      const rows = await requests(1_024, "prepared");
      const due = rows.map((request) => {
        const { payloadSha256: _payloadSha256, ...history } = request as PendingRequestMetadata;
        return {
          ...history,
          resolutionState: "deadline_expired" as const,
          resolvedAtMs: request.deadlineAtMs,
          updatedAtMs: request.deadlineAtMs,
        };
      });
      const effects = new AbortController();
      const ports = {
        requests: {
          async expireDueRequests(query: { limit: number }) {
            return { ok: true as const, requests: due.splice(0, query.limit) };
          },
          async readNextPendingDeadline() {
            if (mode === "throw") throw new Error("schedule failed");
            if (mode === "ownership") throw new OwnershipLostFault("lost");
            if (mode === "abort") {
              effects.abort();
              return new Promise<never>(() => undefined);
            }
            return { malformed: true } as never;
          },
        },
        ownership: { isCurrent: async () => true },
        notifications: { notifyTerminal: () => undefined },
        clock: { nowMs: () => 1 },
      } as unknown as SessionRequestRecoveryPorts;
      const workspaceKey = rows[0]?.workspaceKey;
      if (!workspaceKey) throw new Error("missing schedule failure workspace");
      const result = await expireDueSessionRequests(ports, {
        ...input(workspaceKey),
        effectSignal: effects.signal,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: mode === "ownership" || mode === "abort" ? "ownership_lost" : "storage_unavailable",
        },
      });
    }
  });
});
