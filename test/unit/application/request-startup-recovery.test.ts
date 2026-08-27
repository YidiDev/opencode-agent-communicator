import { describe, expect, test } from "bun:test";
import { admitClaimedSessionRequest } from "../../../src/application/admit-claimed-session-request";
import {
  type CommunicatorStartupRecoveryLifecycle,
  type CommunicatorStartupRecoveryPorts,
  recoverCommunicatorStartup,
} from "../../../src/application/recover-communicator-startup";
import {
  classifyStaleSessionRequests,
  expireDueSessionRequests,
  recoverPreparedSessionRequests,
  type SessionRequestRecoveryPorts,
} from "../../../src/application/recover-session-requests";
import type {
  NativeSteerAdmission,
  RequestAdmissionPersistencePort,
} from "../../../src/application/request-ports";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";
import { expectFinalReadinessRaces } from "../../support/startup-readiness-races";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}
const token = valid(validateFencingToken(7));
async function submittingFixture(createdAtMs = 1_000) {
  const prepared = await requestFixture(token, createdAtMs);
  const request: RequestMetadata & { readonly deliveryState: "submitting" } = {
    ...prepared.request,
    deliveryState: "submitting",
    submittedAtMs: createdAtMs + 1,
    updatedAtMs: createdAtMs + 1,
  };
  return { ...prepared, request };
}
function completion(
  request: RequestMetadata & { readonly deliveryState: "submitting" },
  native: NativeSteerAdmission,
): RequestMetadata {
  const now = request.submittedAtMs + 1;
  if (native.kind === "unknown") {
    return {
      ...request,
      deliveryState: "delivery_unknown",
      deliveryUnknownAtMs: now,
      updatedAtMs: now,
    } as unknown as RequestMetadata;
  }
  if (native.kind === "definitive_rejection") {
    const { payloadSha256: _erased, ...base } = request;
    return {
      ...base,
      deliveryState: "delivery_failed",
      deliveryFailedAtMs: now,
      resolutionState: "delivery_failed",
      resolvedAtMs: now,
      updatedAtMs: now,
    } as unknown as RequestMetadata;
  }
  if (native.kind === "admitted") {
    return {
      ...request,
      deliveryState: "admitted",
      admittedAtMs: native.observedAtMs,
      admissionEvidence: {
        state: "admitted",
        nativeMessageId: request.nativeMessageId,
        admittedSeq: native.admittedSeq,
        observedAtMs: native.observedAtMs,
      },
      updatedAtMs: Math.max(now, native.observedAtMs),
    };
  }
  return {
    ...request,
    deliveryState: "promoted",
    admittedAtMs: native.observedAtMs,
    promotedAtMs: native.observedAtMs,
    admissionEvidence: {
      state: "promoted",
      nativeMessageId: request.nativeMessageId,
      admittedSeq: native.admittedSeq,
      promotedSeq: native.promotedSeq,
      observedAtMs: native.observedAtMs,
    },
    updatedAtMs: Math.max(now, native.observedAtMs),
  };
}
function admissionPorts(
  request: RequestMetadata & { readonly deliveryState: "submitting" },
  native: NativeSteerAdmission,
) {
  const notifications: unknown[] = [];
  let nativeCalls = 0;
  const requests = {
    async completeDelivery() {
      return { ok: true as const, request: completion(request, native) };
    },
  } as unknown as RequestAdmissionPersistencePort;
  return {
    notifications,
    get nativeCalls() {
      return nativeCalls;
    },
    ports: {
      requests,
      nativeSteer: {
        async steerRequest() {
          nativeCalls += 1;
          return native;
        },
      },
      ownership: {
        async acquire() {
          return token;
        },
        async isCurrent() {
          return true;
        },
      },
      notifications: {
        notifyTerminal(event: unknown) {
          notifications.push(event);
          return undefined;
        },
      },
      clock: { nowMs: () => 1_001 },
    },
  };
}

describe("shared claimed request admission", () => {
  test("persists unknown, rejection, admitted, and promoted exact native outcomes", async () => {
    const outcomes: NativeSteerAdmission[] = [
      { kind: "unknown" },
      { kind: "definitive_rejection" },
      { kind: "admitted", admittedSeq: 2, observedAtMs: 1_002 },
      { kind: "promoted", admittedSeq: 2, promotedSeq: 3, observedAtMs: 1_002 },
    ];
    for (const native of outcomes) {
      const fixture = await submittingFixture();
      const harness = admissionPorts(fixture.request, native);
      const result = await admitClaimedSessionRequest(harness.ports, {
        workspaceKey: fixture.request.workspaceKey,
        fencingToken: token,
        request: fixture.request,
        envelope: fixture.envelopeJson,
        control: { abort: new AbortController().signal, deadlineMs: 9_000 },
        effectSignal: new AbortController().signal,
      });
      expect(result.ok).toBe(true);
      expect(harness.nativeCalls).toBe(1);
      expect(harness.notifications.length).toBe(native.kind === "definitive_rejection" ? 1 : 0);
    }
  });

  test("leaves submitting durable when ownership is lost before or after the effect", async () => {
    const fixture = await submittingFixture();
    for (const current of [[false], [true, false]]) {
      const harness = admissionPorts(fixture.request, { kind: "unknown" });
      harness.ports.ownership.isCurrent = async () => current.shift() ?? false;
      const result = await admitClaimedSessionRequest(harness.ports, {
        workspaceKey: fixture.request.workspaceKey,
        fencingToken: token,
        request: fixture.request,
        envelope: fixture.envelopeJson,
        control: { abort: new AbortController().signal, deadlineMs: 9_000 },
        effectSignal: new AbortController().signal,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    }
  });

  test("fails closed for malformed input, malformed native evidence, throws, and unknown store codes", async () => {
    const fixture = await submittingFixture();
    const harness = admissionPorts(fixture.request, { kind: "unknown" });
    expect(
      await admitClaimedSessionRequest(harness.ports, {
        workspaceKey: fixture.request.workspaceKey,
        fencingToken: token,
        request: fixture.request,
        envelope: "",
        control: { abort: new AbortController().signal },
        effectSignal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "state_conflict" } });
    harness.ports.nativeSteer.steerRequest = async () =>
      ({ kind: "admitted", admittedSeq: -1, observedAtMs: -1 }) as NativeSteerAdmission;
    expect(
      await admitClaimedSessionRequest(harness.ports, {
        workspaceKey: fixture.request.workspaceKey,
        fencingToken: token,
        request: fixture.request,
        envelope: fixture.envelopeJson,
        control: { abort: new AbortController().signal },
        effectSignal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: true, value: { outcome: "delivery_unknown" } });
    harness.ports.nativeSteer.steerRequest = async () => {
      throw new Error("native");
    };
    harness.ports.requests.completeDelivery = async () =>
      ({ ok: false, code: "future_code" }) as never;
    expect(
      await admitClaimedSessionRequest(harness.ports, {
        workspaceKey: fixture.request.workspaceKey,
        fencingToken: token,
        request: fixture.request,
        envelope: fixture.envelopeJson,
        control: { abort: new AbortController().signal },
        effectSignal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  });
});

describe("request startup phases", () => {
  test("classifies stale, expires due, skips idle, advances, and steers later active work", async () => {
    const stale = await submittingFixture(2_000);
    const idle = await requestFixture(token, 3_000, "ses_source", "ses_idle");
    const active = await requestFixture(token, 4_000, "ses_source", "ses_active");
    let staleListed = false;
    let preparedListed = false;
    let expiredListed = false;
    const calls: string[] = [];
    const store = {
      async listRecoverableRequests(input: { state: string; cursor?: unknown }) {
        if (input.state === "submitting") {
          if (staleListed) return [];
          staleListed = true;
          return [stale.request];
        }
        if (preparedListed) return [];
        preparedListed = true;
        return [idle.request, active.request];
      },
      async completeDelivery(input: { requestId: string; outcome: string }) {
        const source =
          input.requestId === stale.request.id
            ? stale.request
            : {
                ...active.request,
                deliveryState: "submitting" as const,
                submittedAtMs: 4_001,
                updatedAtMs: 4_001,
              };
        return {
          ok: true as const,
          request: completion(
            source,
            input.outcome === "admitted"
              ? { kind: "admitted", admittedSeq: 1, observedAtMs: source.submittedAtMs + 1 }
              : { kind: "unknown" },
          ),
        };
      },
      async expireDueRequests() {
        if (expiredListed) return { ok: true as const, requests: [] };
        expiredListed = true;
        const failed = completion(stale.request, { kind: "definitive_rejection" });
        return {
          ok: true as const,
          requests: [
            {
              ...failed,
              resolutionState: "deadline_expired",
              resolvedAtMs: stale.request.deadlineAtMs,
              deliveryFailedAtMs: stale.request.deadlineAtMs,
              updatedAtMs: stale.request.deadlineAtMs,
            },
          ],
        };
      },
      async claimPrepared(input: { requestId: string }) {
        const request = input.requestId === active.request.id ? active : idle;
        return {
          ok: true as const,
          request: {
            ...request.request,
            deliveryState: "submitting" as const,
            submittedAtMs: request.request.createdAtMs + 1,
            updatedAtMs: request.request.createdAtMs + 1,
          },
          envelopeJson: request.envelopeJson,
        };
      },
    };
    const ports = {
      requests: store,
      activity: {
        async observeRequestParticipants(_workspace: unknown, _source: unknown, target: string) {
          return {
            sourceVisible: true,
            targetVisible: true,
            targetStatus:
              target === active.request.targetSessionId ? ("busy" as const) : ("idle" as const),
          };
        },
      },
      nativeSteer: {
        async steerRequest() {
          calls.push("steer");
          return { kind: "admitted" as const, admittedSeq: 1, observedAtMs: 4_002 };
        },
      },
      ownership: {
        async acquire() {
          return token;
        },
        async isCurrent() {
          return true;
        },
      },
      notifications: {
        notifyTerminal() {
          return undefined;
        },
      },
      clock: { nowMs: () => 1 },
    } as unknown as SessionRequestRecoveryPorts;
    const input = {
      workspaceKey: stale.request.workspaceKey,
      fencingToken: token,
      startupBarrier: { established: true as const, fencingToken: token },
      abort: new AbortController().signal,
      deadlineMs: 99_000,
      limit: 100,
      effectSignal: new AbortController().signal,
    };
    expect(await classifyStaleSessionRequests(ports, input)).toMatchObject({ ok: true, value: 1 });
    expect(await expireDueSessionRequests(ports, input)).toMatchObject({ ok: true, value: 1 });
    expect(await recoverPreparedSessionRequests(ports, input)).toMatchObject({
      ok: true,
      value: { observed: 2, submitted: 1, skipped: 1 },
    });
    expect(calls).toEqual(["steer"]);
  });
});

describe("request startup strict boundaries", () => {
  test("fails closed at malformed phase, native, expiry, and claim boundaries", async () => {
    const fixture = await requestFixture(token, 6_000);
    const input = {
      workspaceKey: fixture.request.workspaceKey,
      fencingToken: token,
      startupBarrier: { established: true as const, fencingToken: token },
      abort: new AbortController().signal,
      deadlineMs: 99_000,
      limit: 100,
      effectSignal: new AbortController().signal,
    };
    const base = {
      requests: {
        async listRecoverableRequests() {
          return [fixture.request];
        },
        async expireDueRequests() {
          return { ok: true, requests: "bad" };
        },
        async claimPrepared() {
          return { ok: false, code: "future_code" };
        },
      },
      activity: {
        async observeRequestParticipants() {
          throw new Error("native");
        },
      },
      nativeSteer: {
        async steerRequest() {
          return { kind: "unknown" as const };
        },
      },
      ownership: {
        async acquire() {
          return token;
        },
        async isCurrent() {
          return true;
        },
      },
      notifications: {
        notifyTerminal() {
          return undefined;
        },
      },
      clock: { nowMs: () => 1 },
    } as unknown as SessionRequestRecoveryPorts;
    expect(await recoverPreparedSessionRequests(base, { ...input, limit: 0 })).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(await recoverPreparedSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
    base.activity.observeRequestParticipants = async () => ({ malformed: true }) as never;
    expect(await recoverPreparedSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
    base.activity.observeRequestParticipants = async () =>
      ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "malformed",
      }) as never;
    expect(await recoverPreparedSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
    expect(await expireDueSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    base.activity.observeRequestParticipants = async () => ({
      sourceVisible: true,
      targetVisible: true,
      targetStatus: "busy",
    });
    expect(await recoverPreparedSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    base.requests.claimPrepared = async () => {
      throw new Error("claim");
    };
    expect(await recoverPreparedSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    base.requests.listRecoverableRequests = async () => {
      throw new Error("list");
    };
    expect(await recoverPreparedSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    expect(await classifyStaleSessionRequests(base, { ...input, limit: 0 })).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(await classifyStaleSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    base.requests.expireDueRequests = async () => ({
      ok: false,
      code: "ownership_lost",
    });
    expect(await expireDueSessionRequests(base, input)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    let terminalPage = false;
    const { payloadSha256: _erased, ...terminalBase } = fixture.request;
    const terminalPrepared = {
      ...terminalBase,
      resolutionState: "deadline_expired" as const,
      resolvedAtMs: fixture.request.deadlineAtMs,
      updatedAtMs: fixture.request.deadlineAtMs,
    } as RequestMetadata;
    const terminalPorts = {
      ...base,
      requests: {
        ...base.requests,
        async listRecoverableRequests() {
          if (terminalPage) return [];
          terminalPage = true;
          return [fixture.request];
        },
        async claimPrepared() {
          return { ok: true as const, request: terminalPrepared };
        },
      },
    } as SessionRequestRecoveryPorts;
    expect(await recoverPreparedSessionRequests(terminalPorts, input)).toMatchObject({
      ok: true,
      value: { terminalizedAtClaim: 1 },
    });

    const duplicatePorts = {
      ...base,
      requests: {
        ...base.requests,
        async listRecoverableRequests() {
          return [fixture.request, fixture.request];
        },
      },
    } as SessionRequestRecoveryPorts;
    expect(await recoverPreparedSessionRequests(duplicatePorts, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const staleFixture = await submittingFixture(7_000);
    const staleFailurePorts = {
      ...base,
      requests: {
        ...base.requests,
        async listRecoverableRequests() {
          return [staleFixture.request];
        },
        async completeDelivery() {
          throw new Error("write");
        },
      },
    } as SessionRequestRecoveryPorts;
    expect(await classifyStaleSessionRequests(staleFailurePorts, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    const staleMalformedPorts = {
      ...staleFailurePorts,
      requests: {
        ...staleFailurePorts.requests,
        async completeDelivery() {
          return { ok: true as const, request: staleFixture.request };
        },
      },
    } as SessionRequestRecoveryPorts;
    expect(await classifyStaleSessionRequests(staleMalformedPorts, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  });
});
async function expectInitialSchedulerFailures(
  ports: CommunicatorStartupRecoveryPorts,
  request: RequestMetadata,
): Promise<void> {
  for (const [storeCode, expectedCode, runtimeOutcome] of [
    ["storage_unavailable", "storage_unavailable", "shutdown"],
    ["ownership_lost", "ownership_lost", "ownership_lost"],
  ] as const) {
    let expiryCalls = 0;
    const runtime = new RequestRuntime();
    const result = await recoverCommunicatorStartup(
      {
        ...ports,
        runtime,
        requests: {
          ...ports.requests,
          async expireDueRequests() {
            expiryCalls += 1;
            return expiryCalls <= 2
              ? { ok: true as const, requests: [] }
              : { ok: false as const, code: storeCode };
          },
        },
      },
      {
        workspaceKey: request.workspaceKey,
        abort: new AbortController().signal,
        deadlineMs: 9_000,
        limit: 100,
        timers: { set: () => 1, clear() {} },
        nowMonotonicMs: () => 1,
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: expectedCode } });
    expect(
      await runtime.attach({
        requestId: request.id,
        expectedKind: "wait",
        sourceSessionId: request.sourceSessionId,
        workspaceKey: request.workspaceKey,
      }).outcome,
    ).toEqual({
      outcome: runtimeOutcome,
    });
  }
}
async function startupCoordinatorFixture() {
  const prepared = await requestFixture(token, 5_000);
  const events: string[] = [];
  let exposedLifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  const simulateOrdinaryCreation = (): void => {
    if (!exposedLifecycle) throw new Error("Communicator application lifecycle is not ready.");
    exposedLifecycle.assertReady();
  };
  const runtime = new RequestRuntime();
  const store = {
    listParticipantDeletionCandidates: async () => ({ ok: true as const, sessionIds: [] }),
    deleteAbsentParticipantRequests: async () => ({ ok: true as const, terminalized: [] }),
    async listRecoverableRequests() {
      expect(() => simulateOrdinaryCreation()).toThrow("not ready");
      return [];
    },
    async expireDueRequests() {
      expect(() => simulateOrdinaryCreation()).toThrow("not ready");
      events.push("expire");
      return { ok: true as const, requests: [] };
    },
    async readNextPendingDeadline() {
      expect(() => simulateOrdinaryCreation()).toThrow("not ready");
      events.push("schedule");
      return { storeObservedAtMs: 1, maximumSleepMs: 10 };
    },
  } as unknown as RequestAdmissionPersistencePort & {
    listRecoverableRequests(): Promise<readonly RequestMetadata[]>;
    readNextPendingDeadline(): Promise<{ storeObservedAtMs: number; maximumSleepMs: number }>;
  };
  const ports = {
    membership: {
      async readCurrentRoots() {
        return { sourceVisible: true, targetVisible: true, sourceTitle: "source" };
      },
    },
    deliveries: {
      async listRecoverable() {
        expect(() => simulateOrdinaryCreation()).toThrow("not ready");
        return [];
      },
      async garbageCollectMetadata() {
        expect(() => simulateOrdinaryCreation()).toThrow("not ready");
        events.push("delivery-retention");
        return { ok: true as const, deletedDeliveries: 0, deletedRateEvents: 0 };
      },
    },
    nativeQueue: {
      async queueMessage() {
        return { kind: "unknown" as const };
      },
    },
    requests: store,
    participantPresence: { readParticipantPresence: async () => "present" as const },
    activity: {
      async observeRequestParticipants() {
        return { sourceVisible: true, targetVisible: true, targetStatus: "idle" as const };
      },
    },
    nativeSteer: {
      async steerRequest() {
        return { kind: "unknown" as const };
      },
    },
    ownership: {
      async acquire() {
        events.push("acquire");
        return token;
      },
      async isCurrent() {
        return true;
      },
    },
    startupBarrier: {
      async establish() {
        events.push("barrier");
        return { established: true as const, fencingToken: token };
      },
    },
    clock: { nowMs: () => 1 },
    runtime,
    resultRetention: {
      async expireAvailableResults() {
        expect(() => simulateOrdinaryCreation()).toThrow("not ready");
        events.push("result-hygiene");
        return { ok: true as const, requests: [] };
      },
    },
    requestRetention: {
      async collectRequestRetention() {
        expect(() => simulateOrdinaryCreation()).toThrow("not ready");
        events.push("retention-hygiene");
        return { ok: true as const, deletedRequests: 0, deletedRateEvents: 0 };
      },
    },
    starts: { listRecoverable: async () => [] } as never,
  } as unknown as CommunicatorStartupRecoveryPorts;
  return {
    prepared,
    events,
    ports,
    exposeLifecycle(lifecycle: CommunicatorStartupRecoveryLifecycle) {
      exposedLifecycle = lifecycle;
    },
    simulateOrdinaryCreation,
  };
}
describe("startup coordinator lifecycle", () => {
  test("acquires one barrier, starts scheduler last, and stops without closing composition", async () => {
    const fixture = await startupCoordinatorFixture();
    const result = await recoverCommunicatorStartup(fixture.ports, {
      workspaceKey: fixture.prepared.request.workspaceKey,
      abort: new AbortController().signal,
      deadlineMs: 9_000,
      limit: 100,
      timers: {
        set() {
          fixture.events.push("timer");
          return 1;
        },
        clear() {},
      },
      nowMonotonicMs: () => 1,
    });
    expect(result.ok).toBe(true);
    expect(fixture.events.slice(0, 2)).toEqual(["acquire", "barrier"]);
    await expectFinalReadinessRaces(fixture.ports, fixture.prepared.request);
    if (!result.ok) return;
    fixture.exposeLifecycle(result.value);
    expect(() => fixture.simulateOrdinaryCreation()).not.toThrow();
    expect(result.value.status).toBe("ready");
    expect(() => result.value.assertReady()).not.toThrow();
    expect(result.value.stopReason).toBeUndefined();
    expect(result.value.schedulerFault).toBeUndefined();
    result.value.stop("shutdown");
    result.value.stop("ownership_lost");
    expect(result.value.stopReason).toBe("shutdown");
    expect(result.value.status).toBe("stopped");
    expect(() => result.value.assertReady()).toThrow("not ready");
  });
  test("stops the runtime when startup arguments are invalid", async () => {
    const fixture = await startupCoordinatorFixture();
    const stopped = new RequestRuntime();
    const invalid = await recoverCommunicatorStartup(
      { ...fixture.ports, runtime: stopped },
      {
        workspaceKey: fixture.prepared.request.workspaceKey,
        abort: new AbortController().signal,
        deadlineMs: 0,
        limit: 0,
      },
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(
      await stopped.attach({
        requestId: fixture.prepared.request.id,
        expectedKind: "wait",
        sourceSessionId: fixture.prepared.request.sourceSessionId,
        workspaceKey: fixture.prepared.request.workspaceKey,
      }).outcome,
    ).toEqual({ outcome: "shutdown" });
  });
});
describe("startup coordinator scheduler failures", () => {
  test("reports ownership loss after recovery", async () => {
    const fixture = await startupCoordinatorFixture();
    const lost = await recoverCommunicatorStartup(
      {
        ...fixture.ports,
        runtime: new RequestRuntime(),
        ownership: {
          ...fixture.ports.ownership,
          async isCurrent() {
            return false;
          },
        },
      },
      {
        workspaceKey: fixture.prepared.request.workspaceKey,
        abort: new AbortController().signal,
        deadlineMs: 9_000,
        limit: 100,
      },
    );
    expect(lost).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });
  test("shuts down the runtime after an initial malformed scheduler read", async () => {
    const fixture = await startupCoordinatorFixture();
    const faultRuntime = new RequestRuntime();
    const faulted = await recoverCommunicatorStartup(
      {
        ...fixture.ports,
        runtime: faultRuntime,
        requests: {
          ...fixture.ports.requests,
          async readNextPendingDeadline() {
            return { malformed: true } as never;
          },
        },
      },
      {
        workspaceKey: fixture.prepared.request.workspaceKey,
        abort: new AbortController().signal,
        deadlineMs: 9_000,
        limit: 100,
        nowMonotonicMs: () => 1,
      },
    );
    expect(faulted).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(
      await faultRuntime.attach({
        requestId: fixture.prepared.request.id,
        expectedKind: "wait",
        sourceSessionId: fixture.prepared.request.sourceSessionId,
        workspaceKey: fixture.prepared.request.workspaceKey,
      }).outcome,
    ).toEqual({ outcome: "shutdown" });
  });
  test("maps initial scheduler persistence failures", async () => {
    const fixture = await startupCoordinatorFixture();
    await expectInitialSchedulerFailures(fixture.ports, fixture.prepared.request);
  });
});
