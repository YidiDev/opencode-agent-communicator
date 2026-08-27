import { expect, test } from "bun:test";

import { startReadyLifecycle } from "../../../src/application/communicator-ready-lifecycle";
import type { CommunicatorStartupRecoverySummary } from "../../../src/application/communicator-startup-lifecycle";
import type {
  CommunicatorStartupRecoveryInput,
  CommunicatorStartupRecoveryPorts,
} from "../../../src/application/communicator-startup-types";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const fencingToken = value(validateFencingToken(8));
const workspaceKey = value(validateWorkspaceKey("workspace:ready-failure"));
const summary: CommunicatorStartupRecoverySummary = {
  participantDeletionCandidates: 0,
  participantDeletionsObserved: 0,
  participantDeletionUnknown: 0,
  participantRequestsTerminalized: 0,
  staleMessages: 0,
  staleRequests: 0,
  preparedStartsAwaitingApproval: 0,
  startCreationOutcomesUnknown: 0,
  startTitleOutcomesUnknown: 0,
  startAdmissionsUnknown: 0,
  dueRequestsBeforePrepared: 0,
  preparedMessagesSubmitted: 0,
  preparedMessagesCancelled: 0,
  preparedRequestsObserved: 0,
  preparedRequestsSubmitted: 0,
  preparedRequestsSkipped: 0,
  requestsTerminalizedAtClaim: 0,
  dueRequestsAfterPrepared: 0,
  expiredResults: 0,
  retainedRequestsDeleted: 0,
  retainedRateEventsDeleted: 0,
  retainedStartOperationsDeleted: 0,
  retainedStartRateEventsDeleted: 0,
  retainedDeliveriesDeleted: 0,
  retainedDeliveryRateEventsDeleted: 0,
};

test("readiness reports an initial scheduler ownership fault and stops its runtime", async () => {
  const runtime = new RequestRuntime();
  const ports = {
    requests: {
      async expireDueRequests() {
        return { ok: false as const, code: "ownership_lost" as const };
      },
      async readNextPendingDeadline() {
        throw new Error("must not schedule after expiry fault");
      },
    },
    runtime,
    ownership: { acquire: async () => fencingToken, isCurrent: async () => true },
    clock: { nowMs: () => 1 },
    resultRetention: {},
    requestRetention: {},
  } as unknown as CommunicatorStartupRecoveryPorts;
  const input = {
    workspaceKey,
    abort: new AbortController().signal,
    deadlineMs: 100,
    limit: 100,
    timers: { set: () => 1, clear() {} },
    nowMonotonicMs: () => 1,
  } satisfies CommunicatorStartupRecoveryInput;

  const result = await startReadyLifecycle(ports, input, fencingToken, summary, input.abort);
  expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});
