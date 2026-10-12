import { expect, test } from "bun:test";

import {
  admitClaimedSessionRequest,
  type ClaimedSessionRequestAdmissionPorts,
} from "../../../src/application/admit-claimed-session-request";
import {
  authorizeBlockingRequest,
  currentRequestOwnership,
  linkedAdmissionController,
  wakeRequestScheduler,
} from "../../../src/application/blocking-request-creation-preconditions";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import {
  type ImmediateRequestAdmissionPorts,
  persistAndAdmitImmediateRequest,
} from "../../../src/application/immediate-session-request-admission";
import {
  applyParticipantDeletion,
  ParticipantDeletionReconciliationFault,
  reconcileParticipantDeletions,
} from "../../../src/application/participant-deletion-reconciliation";
import { ParticipantOperationGate } from "../../../src/application/participant-operation-gate";
import { ParticipantStopLifecycle } from "../../../src/application/participant-stop-lifecycle";
import { digestMessageContent } from "../../../src/domain/message-payload";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import { canonicalizeSerializeAndDigestPendingRequestPayload } from "../../../src/domain/request-serialization";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestDigestPort, requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function blockingPreconditionHarness() {
  const request = (await requestFixture(token, 1_000)).request;
  const context: SessionBlockingRequestContext = {
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    fencingToken: token,
    abort: new AbortController().signal,
    deadlineMs: request.deadlineAtMs,
  };
  const ports = {
    ownership: { isCurrent: async () => true },
    authorization: { authorizeRequest: async () => ({ kind: "allow" as const }) },
    clock: { nowMs: () => 1_000 },
  } as unknown as SessionBlockingRequestPorts;
  return { context, ports, request };
}

test("blocking preconditions classify ownership faults and malformed authorization", async () => {
  const ownership = await blockingPreconditionHarness();
  ownership.ports.ownership.isCurrent = async () => {
    throw new OwnershipLostFault();
  };
  expect(await currentRequestOwnership(ownership.ports, ownership.context)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });

  for (const decision of [{ kind: "future" }, null]) {
    const authorization = await blockingPreconditionHarness();
    authorization.ports.authorization.authorizeRequest = async () => decision as never;
    expect(
      await authorizeBlockingRequest(
        authorization.ports,
        authorization.context,
        authorization.request,
        30,
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("scheduler wake and linked admission controllers contain asynchronous edge cases", async () => {
  wakeRequestScheduler({
    wake: (() => Promise.reject(new Error("wake rejected"))) as never,
  });
  wakeRequestScheduler({
    wake() {
      throw new Error("wake threw");
    },
  });
  await Promise.resolve();

  const caller = new AbortController();
  const lifecycle = new AbortController();
  lifecycle.abort("stopped");
  expect(linkedAdmissionController(caller.signal, lifecycle.signal).signal.reason).toBe("stopped");

  const activeCaller = new AbortController();
  const activeLifecycle = new AbortController();
  const linked = linkedAdmissionController(activeCaller.signal, activeLifecycle.signal);
  activeLifecycle.abort("lost");
  expect(linked.signal.aborted).toBe(true);
});

test("claimed queue admission never invents sequence evidence for a public message", async () => {
  const fixture = await requestFixture(token, 1_000);
  const request = {
    ...fixture.request,
    deliveryMode: "queue" as const,
    deliveryState: "submitting" as const,
    submittedAtMs: 1_001,
    updatedAtMs: 1_001,
  };
  const completed: RequestMetadata = {
    ...request,
    deliveryState: "delivery_unknown",
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  };
  const ports = {
    requests: { completeDelivery: async () => ({ ok: true, request: completed }) },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    nativeQueue: {
      queueMessage: async () => ({ kind: "public_message" as const, observedAtMs: 1_002 }),
    },
    ownership: { isCurrent: async () => true },
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => 1_001 },
  } as unknown as ClaimedSessionRequestAdmissionPorts;
  expect(
    await admitClaimedSessionRequest(ports, {
      workspaceKey: request.workspaceKey,
      fencingToken: token,
      request,
      envelope: fixture.envelopeJson,
      control: { abort: new AbortController().signal, deadlineMs: 9_000 },
      effectSignal: new AbortController().signal,
    }),
  ).toMatchObject({ ok: true, value: { outcome: "delivery_unknown" } });
});

async function immediateHarness() {
  const fixture = await requestFixture(token, 10_000);
  const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(requestDigestPort, {
    kind: "wait",
    milestone: "covered",
    timeoutSeconds: 30,
  });
  if (!payload.ok) throw new Error("invalid payload fixture");
  const registration = {
    outcome: Promise.resolve({
      outcome: "settled" as const,
      event: {
        id: fixture.request.id,
        kind: "request" as const,
        state: "context_admitted" as const,
      },
    }),
    detach: () => undefined,
  };
  const admitted: RequestMetadata = {
    ...fixture.request,
    deliveryMode: "context",
    deliveryState: "context_admitted",
    awaitingContextAtMs: 10_001,
    contextAdmittedAtMs: 10_002,
    updatedAtMs: 10_002,
  };
  const workBytes = new TextEncoder().encode("work");
  const workSha256 = await digestMessageContent(requestDigestPort, workBytes);
  let lifecycleStops = 0;
  const ports = {
    readiness: {
      fencingToken: token,
      assertReady: () => undefined,
      ownershipLost: () => {
        lifecycleStops += 1;
      },
    },
    contexts: {
      getContextAdmission: async () => ({
        id: fixture.request.id,
        kind: "request",
        workspaceKey: fixture.request.workspaceKey,
        sourceSessionId: fixture.request.sourceSessionId,
        targetSessionId: fixture.request.targetSessionId,
        state: "context_admitted",
        contentByteLength: 1,
        contentSha256: "0".repeat(64),
        createdAtMs: 10_000,
        updatedAtMs: 10_002,
        awaitingContextAtMs: 10_001,
        contextAdmittedAtMs: 10_002,
        claimedFencingToken: token,
      }),
    },
    contextRuntime: { effectSignal: new AbortController().signal, attach: () => registration },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "busy" as const,
      }),
    },
    participantOperations: {
      run: async (_ids: unknown, _abort: unknown, operation: () => unknown) => operation(),
    },
    requests: {
      createPrepared: async ({ request }: { request: RequestMetadata }) => ({ ok: true, request }),
      claimPrepared: async () => ({
        ok: true,
        request: {
          ...fixture.request,
          deliveryMode: "queue",
          deliveryState: "submitting",
          submittedAtMs: 10_001,
          updatedAtMs: 10_001,
        },
        envelopeJson: fixture.envelopeJson,
      }),
      completeDelivery: async () => ({
        ok: true,
        request: {
          ...fixture.request,
          deliveryMode: "queue",
          deliveryState: "delivery_unknown",
          submittedAtMs: 10_001,
          deliveryUnknownAtMs: 10_002,
          updatedAtMs: 10_002,
        },
      }),
      getRequestMetadata: async () => admitted,
    },
    scheduler: { wake: () => undefined },
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
    ownership: { isCurrent: async () => true },
    ids: {
      requestId: () => fixture.request.id,
      nativeMessageId: () => fixture.request.nativeMessageId,
      startOperationId: () => fixture.creationOperationId,
    },
    digest: requestDigestPort,
    clock: { nowMs: () => 10_000 },
  } as unknown as ImmediateRequestAdmissionPorts;
  const input = {
    context: {
      workspaceKey: fixture.request.workspaceKey,
      sourceSessionId: fixture.request.sourceSessionId,
      fencingToken: token,
      abort: new AbortController().signal,
    },
    args: { session_id: fixture.request.targetSessionId, content: "work" },
    payload,
    workBytes,
    workSha256,
    createdAtMs: 10_000,
    deadlineAtMs: 40_000,
    interrupted: () =>
      ({ ok: false as const, error: { code: "request_cancelled" as const } }) as never,
  };
  return {
    admitted,
    input,
    ports,
    registration,
    requestId: fixture.request.id,
    lifecycleStops: () => lifecycleStops,
  };
}

test("legacy immediate context harness fails closed without invoking context seams", async () => {
  for (const hidden of ["source", "target"] as const) {
    const value = await immediateHarness();
    let detached = 0;
    value.registration.detach = () => {
      detached += 1;
    };
    const activity = value.ports.activity;
    if (!activity) throw new Error("missing activity fixture");
    activity.observeRequestParticipants = async () => ({
      sourceVisible: hidden !== "source",
      targetVisible: hidden !== "target",
      targetStatus: "busy",
    });
    expect(await persistAndAdmitImmediateRequest(value.ports, value.input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    expect(detached).toBe(0);
  }

  const missing = await immediateHarness();
  let detached = 0;
  missing.registration.detach = () => {
    detached += 1;
  };
  const contexts = missing.ports.contexts;
  if (!contexts) throw new Error("missing context fixture");
  contexts.getContextAdmission = async () => undefined;
  expect(await persistAndAdmitImmediateRequest(missing.ports, missing.input)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
  expect(detached).toBe(0);
});

test("legacy immediate harness failure does not consume its final metadata read", async () => {
  const value = await immediateHarness();
  value.ports.requests.getRequestMetadata = async () => {
    throw new OwnershipLostFault();
  };
  expect(await persistAndAdmitImmediateRequest(value.ports, value.input)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
  expect(value.lifecycleStops()).toBe(0);
});

test("immediate admission rejects an unsafe post-persistence clock before context reads", async () => {
  const value = await immediateHarness();
  const createPrepared = value.ports.requests.createPrepared.bind(value.ports.requests);
  value.ports.requests.createPrepared = async (input) => {
    const result = await createPrepared(input);
    value.ports.clock.nowMs = () => Number.NaN;
    return result;
  };
  expect(await persistAndAdmitImmediateRequest(value.ports, value.input)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable", details: { request_id: value.requestId } },
  });
});

async function terminalContextRequest(
  resolutionState: "target_deleted" | "target_stopped",
): Promise<RequestMetadata> {
  const fixture = await requestFixture(token, 1_000, "ses_source", "ses_target");
  const { payloadSha256: _payloadSha256, ...request } = fixture.request;
  return {
    ...request,
    deliveryMode: "context",
    resolutionState,
    resolvedAtMs: 1_001,
    updatedAtMs: 1_001,
  } as unknown as RequestMetadata;
}

function failedContextAdmission(request: RequestMetadata) {
  return {
    id: request.id,
    kind: "request" as const,
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    targetSessionId: request.targetSessionId,
    state: "failed" as const,
    contentByteLength: 1,
    contentSha256: "0".repeat(64),
    createdAtMs: 1_000,
    updatedAtMs: 1_001,
    awaitingContextAtMs: 1_000,
    failedAtMs: 1_001,
  };
}

test("participant deletion cancels request context and fails remaining participant context", async () => {
  const request = await terminalContextRequest("target_deleted");
  const events: string[] = [];
  let contextCalls = 0;
  const options = {
    requests: {
      deleteParticipantRequests: async () => ({ ok: true, terminalized: [request] }),
    },
    notifications: { notifyTerminal: () => undefined },
    contexts: {
      settlePendingContextForParticipant: async () => {
        contextCalls += 1;
        return contextCalls === 1 ? [failedContextAdmission(request)] : [];
      },
    },
    contextNotifications: {
      notifyContextSettled(event: { state: string }) {
        events.push(event.state);
      },
    },
    lifecycle: { fencingToken: token },
    workspaceKey: request.workspaceKey,
  } as never;
  expect(await applyParticipantDeletion(options, request.targetSessionId)).toBe(1);
  expect(events).toEqual(["cancelled", "failed"]);
});

test("participant deletion contains deletion storage rejection", async () => {
  const request = await terminalContextRequest("target_deleted");
  await expect(
    reconcileParticipantDeletions(
      {
        requests: {
          listParticipantDeletionCandidates: async () => ({
            ok: true,
            sessionIds: [request.targetSessionId],
          }),
          deleteAbsentParticipantRequests: async () => {
            throw new Error("store unavailable");
          },
        },
        presence: { readParticipantPresence: async () => "absent" },
        notifications: { notifyTerminal: () => undefined },
        lifecycle: { fencingToken: token },
        workspaceKey: request.workspaceKey,
      } as never,
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ParticipantDeletionReconciliationFault);
});

test("participant stop cancels terminal request context and drains pending context", async () => {
  const request = await terminalContextRequest("target_stopped");
  const events: string[] = [];
  let contextCalls = 0;
  let timer: (() => void) | undefined;
  const lifecycle = {
    fencingToken: token,
    status: "ready",
    effectSignal: new AbortController().signal,
    stop() {},
  };
  const handler = new ParticipantStopLifecycle({
    requests: {
      listParticipantStopCandidates: async () => ({ ok: true, sessionIds: [] }),
      stopPendingBlockingRequests: async () => ({ ok: true, terminalized: [request] }),
    } as never,
    activity: {
      observeParticipantActivities: async (_workspace, ids) =>
        ids.map((sessionId) => ({ sessionId, activity: "idle" as const })),
    },
    operations: new ParticipantOperationGate(),
    notifications: { notifyTerminal: () => undefined },
    contexts: {
      settlePendingContextForParticipant: async () => {
        contextCalls += 1;
        return contextCalls === 1 ? [failedContextAdmission(request)] : [];
      },
    } as never,
    contextNotifications: {
      notifyContextSettled(event) {
        events.push(event.state);
      },
    },
    lifecycle: lifecycle as never,
    workspaceKey: request.workspaceKey,
    timers: {
      set(_delay, callback) {
        timer = callback;
        return 1;
      },
      clear() {},
    },
  });
  expect(timer).toBeDefined();
  await handler.handle({
    id: "evt_idle",
    created: 1,
    type: "session.idle",
    data: { sessionID: request.targetSessionId },
  });
  expect(events).toEqual(["cancelled", "failed"]);
  await handler.dispose();
});

test("participant stop rejects malformed candidate result during periodic reconciliation", async () => {
  let timer: (() => void) | undefined;
  const stopped: string[] = [];
  const lifecycle = {
    fencingToken: token,
    status: "ready",
    effectSignal: new AbortController().signal,
    stop(reason: string) {
      stopped.push(reason);
      this.status = "stopped";
    },
  };
  const handler = new ParticipantStopLifecycle({
    requests: {
      listParticipantStopCandidates: async () => ({ ok: true, sessionIds: "bad" }),
    } as never,
    activity: { observeParticipantActivities: async () => [] },
    operations: new ParticipantOperationGate(),
    notifications: { notifyTerminal: () => undefined },
    lifecycle: lifecycle as never,
    workspaceKey: (await requestFixture(token)).request.workspaceKey,
    timers: {
      set(_delay, callback) {
        timer = callback;
        return 1;
      },
      clear() {},
    },
  });
  timer?.();
  for (let index = 0; index < 20 && stopped.length === 0; index += 1) await Promise.resolve();
  expect(stopped).toEqual(["shutdown"]);
  await handler.dispose();
});
