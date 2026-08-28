import { expect, test } from "bun:test";

import { readAuthoritativeRequest } from "../../../src/application/blocking-request-source-projection";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import { classifyStaleSessionRequests } from "../../../src/application/classify-stale-session-requests";
import { recoverOnePreparedSessionRequest } from "../../../src/application/recover-one-prepared-session-request";
import type {
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "../../../src/application/request-ports";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;
const approvedPayload = { kind: "wait", milestone: "compiled ✓", timeoutSeconds: 30 } as const;

async function recoveryFixture() {
  const fixture = await requestFixture(token, 1_000);
  const submitting = {
    ...fixture.request,
    deliveryState: "submitting" as const,
    submittedAtMs: 1_001,
    updatedAtMs: 1_001,
  };
  const effect = new AbortController();
  const input: SessionRequestRecoveryPhaseInput = {
    workspaceKey: fixture.request.workspaceKey,
    fencingToken: token,
    startupBarrier: { established: true, fencingToken: token },
    abort: new AbortController().signal,
    effectSignal: effect.signal,
    deadlineMs: 9_000,
    limit: 10,
  };
  const ports = {
    requests: {},
    ownership: { isCurrent: async () => true },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "busy" as const,
      }),
    },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => 1_001 },
  } as unknown as SessionRequestRecoveryPorts;
  return { effect, fixture, input, ports, submitting };
}

function unknownCompletion(request: RequestMetadata): RequestMetadata {
  return {
    ...request,
    deliveryState: "delivery_unknown",
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  } as RequestMetadata;
}

test("request-refactor stale classification covers each interruption side of durable writes", async () => {
  const beforeOwnership = await recoveryFixture();
  let beforeReads = 0;
  beforeOwnership.ports.requests.listRecoverableRequests = async () =>
    beforeReads++ === 0 ? [beforeOwnership.submitting] : [];
  let clockReads = 0;
  beforeOwnership.ports.clock.nowMs = () => (++clockReads === 1 ? 1_001 : 9_000);
  expect(
    await classifyStaleSessionRequests(beforeOwnership.ports, beforeOwnership.input),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  const duringOwnership = await recoveryFixture();
  duringOwnership.ports.requests.listRecoverableRequests = async () => [duringOwnership.submitting];
  duringOwnership.ports.ownership.isCurrent = () => {
    duringOwnership.effect.abort("ownership interrupted");
    return new Promise<boolean>(() => undefined);
  };
  expect(
    await classifyStaleSessionRequests(duringOwnership.ports, duringOwnership.input),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  const duringCompletion = await recoveryFixture();
  duringCompletion.ports.requests.listRecoverableRequests = async () => [
    duringCompletion.submitting,
  ];
  duringCompletion.ports.requests.completeDelivery = () => {
    duringCompletion.effect.abort("completion interrupted");
    return new Promise<never>(() => undefined);
  };
  expect(
    await classifyStaleSessionRequests(duringCompletion.ports, duringCompletion.input),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("request-refactor stale traversal rechecks control and rejects malformed pages", async () => {
  const afterWrite = await recoveryFixture();
  let listed = false;
  afterWrite.ports.requests.listRecoverableRequests = async () => {
    if (listed) return [];
    listed = true;
    return [afterWrite.submitting];
  };
  afterWrite.ports.requests.completeDelivery = async () => ({
    ok: true,
    request: unknownCompletion(afterWrite.submitting),
  });
  let completed = false;
  afterWrite.ports.clock.nowMs = () => (completed ? 9_000 : 1_001);
  const complete = afterWrite.ports.requests.completeDelivery;
  afterWrite.ports.requests.completeDelivery = async (input) => {
    const result = await complete(input);
    completed = true;
    return result;
  };
  expect(await classifyStaleSessionRequests(afterWrite.ports, afterWrite.input)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });

  const malformed = await recoveryFixture();
  malformed.ports.requests.listRecoverableRequests = async () => null as never;
  expect(await classifyStaleSessionRequests(malformed.ports, malformed.input)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
});

test("request-refactor stale traversal contains abort-signal contract faults", async () => {
  for (const cause of [new Error("signal listener unavailable"), null]) {
    const setup = await recoveryFixture();
    const effectSignal = new Proxy(setup.effect.signal, {
      get(target, key) {
        if (key === "addEventListener") {
          return () => {
            if (cause) throw cause;
            throw new OwnershipLostFault("lost");
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setup.ports.requests.listRecoverableRequests = async () => [];
    expect(
      await classifyStaleSessionRequests(setup.ports, { ...setup.input, effectSignal }),
    ).toMatchObject({
      ok: false,
      error: { code: cause ? "storage_unavailable" : "ownership_lost" },
    });
  }
});

test("request-refactor prepared recovery stops after activity and during claim", async () => {
  const afterActivity = await recoveryFixture();
  let reads = 0;
  afterActivity.ports.clock.nowMs = () => (++reads === 1 ? 1_001 : 9_000);
  expect(
    await recoverOnePreparedSessionRequest(
      afterActivity.ports,
      afterActivity.input,
      afterActivity.fixture.request,
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  const duringClaim = await recoveryFixture();
  duringClaim.ports.requests.claimPrepared = () => {
    duringClaim.effect.abort("claim interrupted");
    return new Promise<never>(() => undefined);
  };
  expect(
    await recoverOnePreparedSessionRequest(
      duringClaim.ports,
      duringClaim.input,
      duringClaim.fixture.request,
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("request-refactor prepared recovery contains a claim signal-boundary fault", async () => {
  const setup = await recoveryFixture();
  let listenerCalls = 0;
  const effectSignal = new Proxy(setup.effect.signal, {
    get(target, key) {
      if (key === "addEventListener") {
        return (...args: Parameters<AbortSignal["addEventListener"]>) => {
          listenerCalls += 1;
          if (listenerCalls === 2) throw new Error("claim signal listener unavailable");
          return target.addEventListener(...args);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  setup.ports.requests.claimPrepared = async () => ({ ok: true, request: setup.fixture.request });
  expect(
    await recoverOnePreparedSessionRequest(
      setup.ports,
      { ...setup.input, effectSignal },
      setup.fixture.request,
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

function participantMetadata(request: RequestMetadata) {
  return {
    requestId: request.id,
    participantRole: "source" as const,
    kind: request.kind,
    sourceSessionId: request.sourceSessionId,
    targetSessionId: request.targetSessionId,
    resolutionState: "reached" as const,
    deliveryState: "admitted" as const,
    resultState: "available" as const,
    createdAtMs: request.createdAtMs,
    submittedAtMs: request.createdAtMs + 1,
    admittedAtMs: request.createdAtMs + 2,
    resolvedAtMs: request.createdAtMs + 3,
    updatedAtMs: request.createdAtMs + 3,
    deadlineAtMs: request.deadlineAtMs,
    resultAvailableAtMs: request.createdAtMs + 3,
    resultExpiresAtMs: request.createdAtMs + 100,
  };
}

test("request-refactor source projection rejects invalid retention and result-state pairings", async () => {
  const request = (await requestFixture(token)).request;
  const context: SessionBlockingRequestContext = {
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    fencingToken: token,
    abort: new AbortController().signal,
    deadlineMs: request.deadlineAtMs,
  };
  let projection: unknown;
  const ports = {
    requests: { getParticipantRequest: async () => projection },
    notifications: { notifyTerminal: () => undefined },
  } as unknown as SessionBlockingRequestPorts;
  const metadata = participantMetadata(request);
  projection = {
    outcome: "available_result",
    metadata: { ...metadata, resultExpiresAtMs: metadata.resultAvailableAtMs - 1 },
    result: { kind: "wait" },
    terminalized: [],
  };
  expect(
    await readAuthoritativeRequest(
      ports,
      context,
      request,
      approvedPayload,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  projection = {
    outcome: "available_result",
    metadata,
    result: null,
    terminalized: [],
  };
  expect(
    await readAuthoritativeRequest(
      ports,
      context,
      request,
      approvedPayload,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  const hostilePayload = new Proxy(approvedPayload, {
    get(target, key, receiver) {
      if (key === "kind") throw new Error("approved payload unavailable");
      return Reflect.get(target, key, receiver);
    },
  });
  projection = {
    outcome: "available_result",
    metadata,
    result: { kind: "wait" },
    terminalized: [],
  };
  expect(
    await readAuthoritativeRequest(
      ports,
      context,
      request,
      hostilePayload,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});
