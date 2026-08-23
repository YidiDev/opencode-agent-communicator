import { expect } from "bun:test";

import {
  type CommunicatorStartupRecoveryPorts,
  recoverCommunicatorStartup,
} from "../../src/application/recover-communicator-startup";
import { RequestRuntime } from "../../src/application/request-runtime";
import type { RequestMetadata } from "../../src/domain/request-types";

export async function expectFinalReadinessRaces(
  ports: CommunicatorStartupRecoveryPorts,
  request: RequestMetadata,
): Promise<void> {
  let schedulerReady = false;
  const runtime = new RequestRuntime();
  const ownershipLost = await recoverCommunicatorStartup(
    {
      ...ports,
      runtime,
      ownership: {
        ...ports.ownership,
        async isCurrent() {
          return !schedulerReady;
        },
      },
    },
    {
      workspaceKey: request.workspaceKey,
      abort: new AbortController().signal,
      deadlineMs: 9_000,
      limit: 100,
      timers: {
        set() {
          schedulerReady = true;
          return 1;
        },
        clear() {},
      },
      nowMonotonicMs: () => 1,
    },
  );
  expect(ownershipLost).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  expect(runtime.effectSignal.aborted).toBe(true);

  let nowMs = 1;
  schedulerReady = false;
  const clockAdvanced = await recoverCommunicatorStartup(
    {
      ...ports,
      runtime: new RequestRuntime(),
      clock: { nowMs: () => nowMs },
      ownership: {
        ...ports.ownership,
        async isCurrent() {
          if (schedulerReady) nowMs = 9_000;
          return true;
        },
      },
    },
    {
      workspaceKey: request.workspaceKey,
      abort: new AbortController().signal,
      deadlineMs: 9_000,
      limit: 100,
      timers: {
        set() {
          schedulerReady = true;
          return 1;
        },
        clear() {},
      },
      nowMonotonicMs: () => 1,
    },
  );
  expect(clockAdvanced).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  let timerCallback: (() => void) | undefined;
  let scheduleReads = 0;
  const schedulerFaulted = await recoverCommunicatorStartup(
    {
      ...ports,
      runtime: new RequestRuntime(),
      requests: {
        ...ports.requests,
        async readNextPendingDeadline() {
          scheduleReads++;
          return scheduleReads === 1
            ? { storeObservedAtMs: 1, maximumSleepMs: 10 }
            : ({ malformed: true } as never);
        },
      },
      ownership: {
        ...ports.ownership,
        async isCurrent() {
          if (timerCallback) {
            const fire = timerCallback;
            timerCallback = undefined;
            fire();
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return true;
        },
      },
    },
    {
      workspaceKey: request.workspaceKey,
      abort: new AbortController().signal,
      deadlineMs: 9_000,
      limit: 100,
      timers: {
        set(_delay, callback) {
          timerCallback = callback;
          return 1;
        },
        clear() {
          timerCallback = undefined;
        },
      },
      nowMonotonicMs: () => 1,
    },
  );
  expect(schedulerFaulted).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
}
