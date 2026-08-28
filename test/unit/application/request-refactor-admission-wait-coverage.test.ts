import { expect, test } from "bun:test";

import {
  admitClaimedSessionRequest,
  type ClaimedSessionRequestAdmissionPorts,
} from "../../../src/application/admit-claimed-session-request";
import { blockUntilRequestTerminal } from "../../../src/application/blocking-request-terminal-wait";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import type { MessageAdmissionPorts } from "../../../src/application/claimed-message-admission";
import { admitClaimedMessage } from "../../../src/application/claimed-message-admission-effect";
import type { RequestRuntimeRegistration } from "../../../src/application/request-runtime";
import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture, requestSession, requestTestWorkspace } from "../../support/request-store";

const token = 1 as FencingToken;
const approvedPayload = { kind: "wait", milestone: "compiled ✓", timeoutSeconds: 30 } as const;

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid request-refactor fixture");
  return result.value;
}

async function requestAdmissionFixture() {
  const fixture = await requestFixture(token, 1_000);
  const request = {
    ...fixture.request,
    deliveryState: "submitting" as const,
    submittedAtMs: 1_001,
    updatedAtMs: 1_001,
  };
  const effect = new AbortController();
  const ports = {
    requests: {
      completeDelivery: async () => ({ ok: true, request: unknownRequest(request) }),
    },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    ownership: { isCurrent: async () => true },
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => 1_001 },
  } as unknown as ClaimedSessionRequestAdmissionPorts;
  return {
    effect,
    fixture,
    ports,
    input: {
      workspaceKey: request.workspaceKey,
      fencingToken: token,
      request,
      envelope: fixture.envelopeJson,
      control: { abort: new AbortController().signal, deadlineMs: 9_000 },
      effectSignal: effect.signal,
    },
  };
}

function unknownRequest(request: RequestMetadata): RequestMetadata {
  return {
    ...request,
    deliveryState: "delivery_unknown",
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  } as RequestMetadata;
}

test("request-refactor claimed request admission maps interrupted ownership, steer, and completion", async () => {
  const ownership = await requestAdmissionFixture();
  ownership.ports.ownership.isCurrent = () => {
    ownership.effect.abort("ownership interrupted");
    return new Promise<boolean>(() => undefined);
  };
  expect(await admitClaimedSessionRequest(ownership.ports, ownership.input)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });

  const steer = await requestAdmissionFixture();
  steer.ports.nativeSteer.steerRequest = async () => {
    throw new OwnershipLostFault("native steer fenced");
  };
  expect(await admitClaimedSessionRequest(steer.ports, steer.input)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });

  const completion = await requestAdmissionFixture();
  completion.ports.requests.completeDelivery = () => {
    completion.effect.abort("completion interrupted");
    return new Promise<never>(() => undefined);
  };
  expect(await admitClaimedSessionRequest(completion.ports, completion.input)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
});

test("request-refactor claimed request admission rechecks lifecycle immediately around steer", async () => {
  for (const abortOnRead of [5, 6]) {
    const setup = await requestAdmissionFixture();
    let abortedReads = 0;
    const effectSignal = new Proxy(setup.effect.signal, {
      get(target, key) {
        if (key === "aborted") {
          abortedReads += 1;
          return abortedReads >= abortOnRead;
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      await admitClaimedSessionRequest(setup.ports, { ...setup.input, effectSignal }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  }
});

const deliveryId = valid(validateDeliveryId(`dlv_${"6".repeat(32)}`));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"7".repeat(32)}`));

function submittingDelivery(): DeliveryMetadata {
  return {
    id: deliveryId,
    workspaceKey: requestTestWorkspace(),
    sourceSessionId: requestSession("ses_source"),
    targetSessionId: requestSession("ses_target"),
    nativeMessageId,
    state: "submitting",
    contentByteLength: 2,
    contentSha256: "8".repeat(64) as Sha256Digest,
    createdAtMs: 1,
    submittedAtMs: 2,
    updatedAtMs: 2,
  };
}

function messagePorts(overrides: Partial<MessageAdmissionPorts> = {}): MessageAdmissionPorts {
  return {
    ownership: { isCurrent: async () => true } as never,
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
    deliveries: { completeSubmission: async () => ({ malformed: true }) } as never,
    clock: { nowMs: () => 3 },
    ...overrides,
  };
}

test("request-refactor claimed message recovery catches synchronous ownership loss from native queue", async () => {
  const ports = messagePorts({
    nativeQueue: {
      queueMessage: (() => {
        throw new OwnershipLostFault("native queue fenced");
      }) as never,
    },
  });
  expect(
    await admitClaimedMessage(ports, {
      workspaceKey: submittingDelivery().workspaceKey,
      fencingToken: token,
      delivery: submittingDelivery(),
      envelope: "{}",
      abort: new AbortController().signal,
      interruptionMeansOwnershipLoss: true,
    }),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("request-refactor claimed message persists ambiguity when the deadline wins after queueing", async () => {
  let queued = false;
  const ports = messagePorts({
    nativeQueue: {
      queueMessage: async () => {
        queued = true;
        return { kind: "unknown" };
      },
    },
  });
  const input = {
    workspaceKey: submittingDelivery().workspaceKey,
    fencingToken: token,
    delivery: submittingDelivery(),
    envelope: "{}",
    abort: new AbortController().signal,
    get deadlineMs() {
      return queued ? 0 : Date.now() + 10_000;
    },
  };
  expect(await admitClaimedMessage(ports, input)).toMatchObject({
    ok: false,
    error: { code: "admission_unknown" },
  });
});

test("request-refactor claimed message observes a rejected unbounded record and retries unknown", async () => {
  let workspaceReads = 0;
  const delivery = submittingDelivery();
  const input = {
    get workspaceKey() {
      workspaceReads += 1;
      if (workspaceReads === 1) throw new Error("record argument unavailable");
      return delivery.workspaceKey;
    },
    fencingToken: token,
    delivery,
    envelope: "{}",
    abort: new AbortController().signal,
  };
  expect(await admitClaimedMessage(messagePorts(), input)).toMatchObject({
    ok: false,
    error: { code: "admission_unknown" },
  });
  await Promise.resolve();
  expect(workspaceReads).toBeGreaterThanOrEqual(2);
});

function pendingProjection(request: RequestMetadata) {
  return {
    outcome: "metadata",
    view: "source_pending",
    metadata: {
      requestId: request.id,
      participantRole: "source",
      kind: request.kind,
      sourceSessionId: request.sourceSessionId,
      targetSessionId: request.targetSessionId,
      resolutionState: "pending",
      deliveryState: request.deliveryState,
      resultState: "none",
      createdAtMs: request.createdAtMs,
      updatedAtMs: request.updatedAtMs,
      deadlineAtMs: request.deadlineAtMs,
    },
    terminalized: [],
  };
}

function cancelledProjection(request: RequestMetadata) {
  return {
    outcome: "metadata",
    view: "source_unsuccessful_terminal",
    metadata: {
      ...pendingProjection(request).metadata,
      resolutionState: "cancelled",
      resolvedAtMs: request.createdAtMs + 1,
      updatedAtMs: request.createdAtMs + 1,
    },
    terminalized: [],
  };
}

function reachedProjection(request: RequestMetadata) {
  const resolvedAtMs = request.createdAtMs + 3;
  return {
    outcome: "available_result",
    metadata: {
      ...pendingProjection(request).metadata,
      resolutionState: "reached",
      deliveryState: "admitted",
      resultState: "available",
      submittedAtMs: request.createdAtMs + 1,
      admittedAtMs: request.createdAtMs + 2,
      resolvedAtMs,
      updatedAtMs: resolvedAtMs,
      resultAvailableAtMs: resolvedAtMs,
      resultExpiresAtMs: resolvedAtMs + 100,
    },
    result: { kind: "wait", evidence: "request-refactor" },
    terminalized: [],
  };
}

async function waitHarness() {
  const request = (await requestFixture(token)).request;
  const abort = new AbortController();
  const context: SessionBlockingRequestContext = {
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    fencingToken: token,
    abort: abort.signal,
    deadlineMs: request.deadlineAtMs,
  };
  const ports = {
    requests: {},
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => request.createdAtMs },
    scheduler: { wake: () => undefined },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
    runtime: { effectSignal: new AbortController().signal, wakeRequest: () => undefined },
  } as unknown as SessionBlockingRequestPorts;
  return { abort, context, ports, request };
}

test("request-refactor terminal wait lets cancellation win the runtime race", async () => {
  const setup = await waitHarness();
  const { payloadSha256: _payloadSha256, ...terminalBase } = setup.request;
  let reads = 0;
  setup.ports.requests.getParticipantRequest = (async () => {
    reads += 1;
    if (reads === 1)
      return {
        ...pendingProjection(setup.request),
        terminalized: [
          {
            ...terminalBase,
            resolutionState: "cancelled",
            resolvedAtMs: setup.request.createdAtMs + 1,
            updatedAtMs: setup.request.createdAtMs + 1,
          },
        ],
      };
    return cancelledProjection(setup.request);
  }) as never;
  setup.ports.notifications.notifyTerminal = () => {
    setup.abort.abort("cancel while runtime is suspended");
  };
  setup.ports.requests.cancelPending = (async () => ({ ok: true })) as never;
  const registration = {
    outcome: new Promise<never>(() => undefined),
    detach: () => undefined,
  } as unknown as RequestRuntimeRegistration;
  expect(
    await blockUntilRequestTerminal(
      setup.ports,
      setup.context,
      setup.request,
      registration,
      approvedPayload,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
});

test("request-refactor terminal wait returns a terminal reread after reattachment capacity loss", async () => {
  const setup = await waitHarness();
  let reads = 0;
  setup.ports.requests.getParticipantRequest = (async () =>
    ++reads === 1 ? pendingProjection(setup.request) : reachedProjection(setup.request)) as never;
  setup.ports.runtime.attach = (() => {
    throw new Error("waiter capacity exhausted");
  }) as never;
  const registration = {
    outcome: Promise.resolve({ outcome: "terminal" as const }),
    detach: () => undefined,
  } as unknown as RequestRuntimeRegistration;
  expect(
    await blockUntilRequestTerminal(
      setup.ports,
      setup.context,
      setup.request,
      registration,
      approvedPayload,
      new AbortController(),
    ),
  ).toMatchObject({ ok: true, value: { state: "reached", evidence: "request-refactor" } });
});

test("request-refactor terminal cleanup stops immediately with an ended lifecycle", async () => {
  const setup = await waitHarness();
  const lifecycle = new AbortController();
  lifecycle.abort("runtime stopped");
  Object.assign(setup.ports, {
    runtime: { effectSignal: lifecycle.signal, wakeRequest: () => undefined },
  });
  setup.abort.abort("caller stopped");
  setup.ports.requests.cancelPending = () => new Promise<never>(() => undefined);
  setup.ports.requests.getParticipantRequest = () => new Promise<never>(() => undefined);
  const registration = {
    outcome: new Promise<never>(() => undefined),
    detach: () => undefined,
  } as unknown as RequestRuntimeRegistration;
  expect(
    await blockUntilRequestTerminal(
      setup.ports,
      setup.context,
      setup.request,
      registration,
      approvedPayload,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});
