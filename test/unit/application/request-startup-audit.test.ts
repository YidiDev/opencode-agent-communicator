import { expect, test } from "bun:test";
import { runUntilAborted, settleUntilAborted } from "../../../src/application/abortable-operation";
import { admitClaimedSessionRequest } from "../../../src/application/admit-claimed-session-request";
import { classifyStaleMessageDeliveries } from "../../../src/application/recover-message-deliveries";
import {
  classifyStaleSessionRequests,
  expireDueSessionRequests,
  recoverPreparedSessionRequests,
} from "../../../src/application/recover-session-requests";
import { inspectExpiredRequestBatch } from "../../../src/application/request-expiry-boundary";
import type {
  RequestAdmissionPersistencePort,
  SessionRequestRecoveryPorts,
} from "../../../src/application/request-ports";
import { createLinkedStartupEffectControl } from "../../../src/application/startup-effect-control";
import {
  snapshotDataRecord,
  snapshotDenseArray,
} from "../../../src/application/strict-port-boundaries";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const tokenResult = validateFencingToken(31);
if (!tokenResult.ok) throw new Error("invalid token fixture");
const token = tokenResult.value;

async function submittingFixture() {
  const fixture = await requestFixture(token, 1_000);
  return {
    ...fixture,
    request: {
      ...fixture.request,
      deliveryState: "submitting" as const,
      submittedAtMs: 1_001,
      updatedAtMs: 1_001,
    },
  };
}

function unknownCompletion(
  request: RequestMetadata & { readonly deliveryState: "submitting" },
): RequestMetadata {
  return {
    ...request,
    deliveryState: "delivery_unknown",
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  };
}

function admissionHarness(request: RequestMetadata & { readonly deliveryState: "submitting" }) {
  let effects = 0;
  let writes = 0;
  let steer = async () => ({ kind: "unknown" as const });
  const ports = {
    requests: {
      async completeDelivery() {
        writes += 1;
        return { ok: true as const, request: unknownCompletion(request) };
      },
    } as unknown as RequestAdmissionPersistencePort,
    nativeSteer: {
      async steerRequest() {
        effects += 1;
        return steer();
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
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => 1_001 },
  };
  return {
    ports,
    counts: () => ({ effects, writes }),
    setSteer: (next: typeof steer) => {
      steer = next;
    },
  };
}

test("claimed request effects are pre-abort safe and interruption leaves submitting", async () => {
  const fixture = await submittingFixture();
  const preAborted = new AbortController();
  preAborted.abort();
  const first = admissionHarness(fixture.request);
  const input = {
    workspaceKey: fixture.request.workspaceKey,
    fencingToken: token,
    request: fixture.request,
    envelope: fixture.envelopeJson,
    control: { abort: preAborted.signal },
    effectSignal: preAborted.signal,
  };
  expect(await admitClaimedSessionRequest(first.ports, input)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
  expect(first.counts()).toEqual({ effects: 0, writes: 0 });

  const active = new AbortController();
  let reject!: (cause: unknown) => void;
  const held = admissionHarness(fixture.request);
  held.setSteer(() => new Promise((_, fail) => (reject = fail)));
  const pending = admitClaimedSessionRequest(held.ports, {
    ...input,
    control: { abort: active.signal },
    effectSignal: active.signal,
  });
  while (!reject) await Promise.resolve();
  active.abort();
  expect(await pending).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  expect(held.counts()).toEqual({ effects: 1, writes: 0 });
  reject(new Error("late native rejection"));
  await Promise.resolve();
});

test("participant observation is abort bounded and never claims after interruption", async () => {
  const fixture = await requestFixture(token, 2_000);
  const controller = new AbortController();
  let observed = false;
  let claims = 0;
  const ports = {
    requests: {
      async listRecoverableRequests(input: { cursor?: unknown }) {
        return input.cursor === undefined && !observed ? [fixture.request] : [];
      },
      async claimPrepared() {
        claims += 1;
        throw new Error("must not claim");
      },
    },
    activity: {
      observeRequestParticipants() {
        observed = true;
        return new Promise(() => undefined);
      },
    },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => 1 },
  } as unknown as SessionRequestRecoveryPorts;
  const pending = recoverPreparedSessionRequests(ports, {
    workspaceKey: fixture.request.workspaceKey,
    fencingToken: token,
    startupBarrier: { established: true, fencingToken: token },
    abort: controller.signal,
    deadlineMs: 9_000,
    limit: 100,
    effectSignal: controller.signal,
  });
  while (!observed) await Promise.resolve();
  controller.abort();
  expect(await pending).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  expect(claims).toBe(0);
});

test("request startup phase port rejections preserve ownership loss and hide other storage faults", async () => {
  const fixture = await requestFixture(token, 2_500);
  const signal = new AbortController().signal;
  const input = {
    workspaceKey: fixture.request.workspaceKey,
    fencingToken: token,
    startupBarrier: { established: true as const, fencingToken: token },
    abort: signal,
    effectSignal: signal,
    deadlineMs: 9_000,
    limit: 100,
  };
  const base = {
    activity: {
      async observeRequestParticipants() {
        return { sourceVisible: true, targetVisible: true, targetStatus: "busy" as const };
      },
    },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    notifications: { notifyTerminal: () => undefined },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    clock: { nowMs: () => 1 },
  };
  for (const cause of [new OwnershipLostFault("stale"), new Error("private store fault")]) {
    const expected = cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable";
    const rejectingList = {
      ...base,
      requests: {
        async listRecoverableRequests() {
          throw cause;
        },
      },
    } as unknown as SessionRequestRecoveryPorts;
    expect(await classifyStaleSessionRequests(rejectingList, input)).toMatchObject({
      ok: false,
      error: { code: expected },
    });
    expect(await recoverPreparedSessionRequests(rejectingList, input)).toMatchObject({
      ok: false,
      error: { code: expected },
    });
    const rejectingExpiry = {
      ...base,
      requests: {
        async expireDueRequests() {
          throw cause;
        },
      },
    } as unknown as SessionRequestRecoveryPorts;
    expect(await expireDueSessionRequests(rejectingExpiry, input)).toMatchObject({
      ok: false,
      error: { code: expected },
    });
  }

  const claimLost = {
    ...base,
    requests: {
      async listRecoverableRequests(query: { cursor?: unknown }) {
        return query.cursor ? [] : [fixture.request];
      },
      async claimPrepared() {
        throw new OwnershipLostFault("claim stale");
      },
    },
  } as unknown as SessionRequestRecoveryPorts;
  expect(await recoverPreparedSessionRequests(claimLost, input)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
});

test("all immutable request identity fields are checked at admission completion", async () => {
  const fixture = await submittingFixture();
  const mutations: Array<(request: RequestMetadata) => RequestMetadata> = [
    (request) => ({ ...request, id: "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never }),
    (request) => ({ ...request, workspaceKey: "other" as never }),
    (request) => ({ ...request, sourceSessionId: "ses_other" as never }),
    (request) => ({ ...request, targetSessionId: "ses_other" as never }),
    (request) => ({ ...request, nativeMessageId: "msg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never }),
    (request) => ({ ...request, kind: request.kind === "ask" ? "wait" : "ask" }) as RequestMetadata,
    (request) => ({ ...request, createdAtMs: request.createdAtMs + 1 }),
    (request) => ({ ...request, deadlineAtMs: request.deadlineAtMs + 1 }),
    (request) => ({ ...request, payloadByteLength: request.payloadByteLength + 1 }),
    (request) => ({ ...request, payloadSha256: "a".repeat(64) as never }),
  ];
  for (const mutate of mutations) {
    const harness = admissionHarness(fixture.request);
    harness.ports.requests.completeDelivery = async () => ({
      ok: true as const,
      request: mutate(unknownCompletion(fixture.request)),
    });
    const result = await admitClaimedSessionRequest(harness.ports, {
      workspaceKey: fixture.request.workspaceKey,
      fencingToken: token,
      request: fixture.request,
      envelope: fixture.envelopeJson,
      control: { abort: new AbortController().signal },
      effectSignal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("startup effect control enforces the absolute deadline and cleans listeners and timers", () => {
  let now = 10;
  let callback: (() => void) | undefined;
  let clears = 0;
  const timers = {
    set(_delay: number, next: () => void) {
      callback = next;
      return 1;
    },
    clear() {
      clears += 1;
    },
  };
  const control = createLinkedStartupEffectControl({
    caller: new AbortController().signal,
    runtime: new AbortController().signal,
    deadlineMs: 30,
    clock: { nowMs: () => now },
    timers,
  });
  expect(control?.signal.aborted).toBe(false);
  now = 20;
  callback?.();
  expect(control?.signal.aborted).toBe(false);
  now = 30;
  callback?.();
  expect(control?.signal.aborted).toBe(true);
  control?.dispose();

  const disposable = createLinkedStartupEffectControl({
    caller: new AbortController().signal,
    runtime: new AbortController().signal,
    deadlineMs: 40,
    clock: { nowMs: () => 10 },
    timers,
  });
  disposable?.dispose();
  disposable?.dispose();
  expect(clears).toBe(1);

  let throwingCallback: (() => void) | undefined;
  let clockThrows = false;
  const clockFailure = createLinkedStartupEffectControl({
    caller: new AbortController().signal,
    runtime: new AbortController().signal,
    deadlineMs: 40,
    clock: {
      nowMs: () => {
        if (clockThrows) throw new Error("clock");
        return 10;
      },
    },
    timers: {
      set(_delay, next) {
        throwingCallback = next;
        return 1;
      },
      clear() {},
    },
  });
  clockThrows = true;
  throwingCallback?.();
  expect(clockFailure?.signal.aborted).toBe(true);
  expect(
    createLinkedStartupEffectControl({
      caller: new AbortController().signal,
      runtime: new AbortController().signal,
      deadlineMs: 40,
      clock: { nowMs: () => -1 },
      timers,
    })?.signal.aborted,
  ).toBe(true);
  expect(
    createLinkedStartupEffectControl({
      caller: new AbortController().signal,
      runtime: new AbortController().signal,
      deadlineMs: 40,
      clock: { nowMs: () => 10 },
      timers: {
        set: () => {
          throw new Error("timer");
        },
        clear() {},
      },
    }),
  ).toBeUndefined();
});

test("strict record and array snapshots fail closed for throwing reflection", () => {
  const throwingRecord = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("keys");
      },
    },
  );
  const throwingArray = new Proxy([], {
    getPrototypeOf() {
      throw new Error("prototype");
    },
  });
  expect(snapshotDataRecord(throwingRecord, 2)).toBeUndefined();
  expect(snapshotDenseArray(throwingArray, 2)).toBeUndefined();
});

test("abort settlement covers synchronous rejection and already-aborted late observation", async () => {
  const active = new AbortController().signal;
  expect(
    await runUntilAborted(active, () => {
      throw new Error("sync port throw");
    }),
  ).toMatchObject({ kind: "rejected" });
  const stopped = new AbortController();
  stopped.abort();
  const late = Promise.reject(new Error("late"));
  expect(await settleUntilAborted(late, stopped.signal)).toEqual({ kind: "aborted" });
  await Promise.resolve();
});

test("standalone request recovery facades are total for throwing input inspection", async () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("input getter");
      },
    },
  );
  for (const phase of [
    classifyStaleSessionRequests,
    expireDueSessionRequests,
    recoverPreparedSessionRequests,
  ]) {
    expect(await phase({} as never, hostile as never)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  }
});

test("illegal insertion behind a prepared cursor fails the readiness scan closed", async () => {
  const first = await requestFixture(token, 3_000, "ses_source", "ses_first");
  const inserted = await requestFixture(token, 2_500, "ses_source", "ses_inserted");
  let calls = 0;
  const ports = {
    requests: {
      async listRecoverableRequests(input: { cursor?: unknown }) {
        calls += 1;
        if (calls === 1) return [first.request];
        if (input.cursor !== undefined) return [];
        return [inserted.request];
      },
    },
    activity: {
      async observeRequestParticipants() {
        return { sourceVisible: true, targetVisible: true, targetStatus: "idle" as const };
      },
    },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    notifications: { notifyTerminal: () => undefined },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    clock: { nowMs: () => 1 },
  } as unknown as SessionRequestRecoveryPorts;
  expect(
    await recoverPreparedSessionRequests(ports, {
      workspaceKey: first.request.workspaceKey,
      fencingToken: token,
      startupBarrier: { established: true, fencingToken: token },
      abort: new AbortController().signal,
      deadlineMs: 9_000,
      limit: 100,
      effectSignal: new AbortController().signal,
    }),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("throwing recovery clock and unknown expiry codes fail closed", async () => {
  const fixture = await requestFixture(token, 4_000);
  const signal = new AbortController().signal;
  expect(
    await classifyStaleMessageDeliveries(
      {
        clock: {
          nowMs: () => {
            throw new Error("clock");
          },
        },
      } as never,
      {
        workspaceKey: fixture.request.workspaceKey,
        fencingToken: token,
        startupBarrier: { established: true, fencingToken: token },
        abort: signal,
        deadlineMs: 9_000,
        limit: 100,
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  expect(
    inspectExpiredRequestBatch({
      value: { ok: false, code: "future" },
      workspaceKey: fixture.request.workspaceKey,
      seen: new Set(),
      batchLimit: 100,
      hardLimit: 1_024,
    }),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});
