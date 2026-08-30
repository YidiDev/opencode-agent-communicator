import { describe, expect, test } from "bun:test";

import type { ContextAdmissionPersistencePort } from "../../../src/application/context-admission-ports";
import type {
  ContextAdmissionRegistration,
  ContextAdmissionRuntimeOutcome,
} from "../../../src/application/context-admission-runtime";
import {
  ParticipantOperationAbortedFault,
  ParticipantOperationCapacityFault,
} from "../../../src/application/participant-operation-gate";
import { sendContextSessionMessage } from "../../../src/application/session-context-message-delivery";
import type {
  SessionSendContext,
  SessionSendPorts,
} from "../../../src/application/session-message-delivery-contracts";
import type { ValidatedSendInput } from "../../../src/application/session-send-validation";
import type { ContextAdmissionMetadata } from "../../../src/domain/context-admissions";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:context-message"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const deliveryId = valid(validateDeliveryId(`dlv_${"d".repeat(32)}`));
const fencingToken = valid(validateFencingToken(29));
const contentDigest = "a".repeat(64) as Sha256Digest;
const envelopeDigest = "b".repeat(64) as Sha256Digest;
const bytes = new TextEncoder().encode("hello peer");
const input: ValidatedSendInput = {
  target: targetSessionId,
  content: "hello peer",
  bytes,
  byteLength: bytes.length,
  delivery: "context",
};

function admission(state: "awaiting_context" | "context_admitted" | "cancelled") {
  const base: ContextAdmissionMetadata = {
    id: deliveryId,
    kind: "message",
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    state: "awaiting_context",
    contentByteLength: 200,
    contentSha256: envelopeDigest,
    createdAtMs: 101,
    updatedAtMs: 101,
    awaitingContextAtMs: 101,
  };
  if (state === "context_admitted") {
    return {
      ...base,
      state,
      updatedAtMs: 102,
      contextAdmittedAtMs: 102,
      claimedFencingToken: fencingToken,
    } as const;
  }
  if (state === "cancelled") {
    return { ...base, state, updatedAtMs: 102, cancelledAtMs: 102 } as const;
  }
  return base;
}

interface Fixture {
  readonly ports: SessionSendPorts;
  readonly persisted: Array<Parameters<ContextAdmissionPersistencePort["createContextMessage"]>[0]>;
  readonly activityCalls: unknown[][];
  readonly authorizationCalls: unknown[][];
  detached: number;
  lifecycleStops: number;
  digestCalls: number;
  attachThrows: boolean;
  authorization: unknown;
  owner: boolean;
  observation: {
    sourceVisible: boolean;
    targetVisible: boolean;
    targetStatus: "busy" | "idle" | "retry";
  };
  createResult: Awaited<ReturnType<ContextAdmissionPersistencePort["createContextMessage"]>>;
  currentAdmissions: Array<ContextAdmissionMetadata | undefined>;
  registrationOutcome: Promise<ContextAdmissionRuntimeOutcome>;
  gateFault?: unknown;
}

function fixture(): Fixture {
  const persisted: Fixture["persisted"] = [];
  const activityCalls: unknown[][] = [];
  const authorizationCalls: unknown[][] = [];
  const value = {
    persisted,
    activityCalls,
    authorizationCalls,
    detached: 0,
    lifecycleStops: 0,
    digestCalls: 0,
    attachThrows: false,
    authorization: { kind: "allow" },
    owner: true,
    observation: { sourceVisible: true, targetVisible: true, targetStatus: "busy" as const },
    createResult: { ok: true as const, admission: admission("awaiting_context") },
    currentAdmissions: [admission("context_admitted")],
    gateFault: undefined as unknown | undefined,
    registrationOutcome: Promise.resolve({
      outcome: "settled" as const,
      event: { id: deliveryId, kind: "message" as const, state: "context_admitted" as const },
    }),
    ports: undefined as unknown as SessionSendPorts,
  } satisfies Fixture;
  const contexts: ContextAdmissionPersistencePort = {
    async createContextMessage(created) {
      persisted.push(created);
      return value.createResult;
    },
    async getContextAdmission() {
      return value.currentAdmissions.shift();
    },
    async cancelContextAdmission() {
      return { ok: true, admission: admission("cancelled") };
    },
    listPendingContext: async () => [],
    claimPendingContext: async () => [],
    readContextReminders: async () => ({ activeLockCount: 0, availableResults: [] }),
    failPendingContextForParticipant: async () => [],
    failUncertainContextOnStartup: async () => [],
  };
  value.ports = {
    readiness: {
      fencingToken,
      assertReady() {},
      ownershipLost() {
        value.lifecycleStops += 1;
      },
    },
    membership: {
      async readCurrentRoots() {
        return {
          sourceVisible: true,
          targetVisible: true,
          sourceTitle: "\u001b[31mSource\u001b[0m",
        };
      },
    },
    authorization: {
      async authorizeMessage(...args) {
        authorizationCalls.push(args);
        return value.authorization as never;
      },
    },
    deliveries: {} as never,
    nativeQueue: {} as never,
    ownership: {
      acquire: async () => fencingToken,
      isCurrent: async () => value.owner,
    },
    clock: { nowMs: () => 101 },
    ids: {
      deliveryId: () => deliveryId,
      nativeMessageId: () => valid(validateNativeMessageId(`msg_${"e".repeat(32)}`)),
    } as never,
    digest: {
      async sha256() {
        value.digestCalls += 1;
        return new Uint8Array(32).fill(value.digestCalls === 1 ? 0xaa : 0xbb);
      },
    },
    contexts,
    contextRuntime: {
      effectSignal: new AbortController().signal,
      notifyContextSettled: () => undefined,
      attach() {
        if (value.attachThrows) throw new RangeError("capacity");
        const registration: ContextAdmissionRegistration = {
          outcome: value.registrationOutcome,
          detach() {
            value.detached += 1;
          },
        };
        return registration;
      },
    },
    activity: {
      async observeRequestParticipants(...args) {
        activityCalls.push(args);
        return value.observation;
      },
    },
    participantOperations: {
      async run(_ids, _abort, operation) {
        if (value.gateFault) throw value.gateFault;
        return operation();
      },
    },
  };
  return value;
}

function context(controller = new AbortController(), deadlineMs?: number): SessionSendContext {
  return {
    workspaceKey,
    sourceSessionId,
    abort: controller.signal,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
}

describe("context message delivery", () => {
  test("persists a sanitized verified envelope and waits for durable admission", async () => {
    const value = fixture();
    const invocation = context(undefined, Date.now() + 10_000);
    const result = await sendContextSessionMessage(value.ports, invocation, input);

    expect(result).toMatchObject({ ok: true, value: { state: "context_admitted" } });
    expect(value.persisted).toHaveLength(1);
    expect(value.persisted[0]).toMatchObject({
      fencingToken,
      id: deliveryId,
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      contentSha256: envelopeDigest,
      createdAtMs: 101,
    });
    const envelope = JSON.parse(value.persisted[0]?.envelopeJson ?? "");
    expect(envelope).toMatchObject({
      source_session_id: sourceSessionId,
      target_session_id: targetSessionId,
      delivery_id: deliveryId,
      payload: { content: "hello peer" },
      display: { source_title: "Source" },
    });
    expect(value.persisted[0]?.contentByteLength).toBe(
      new TextEncoder().encode(value.persisted[0]?.envelopeJson).length,
    );
    expect(value.authorizationCalls[0]).toMatchObject([
      {
        operation: "message",
        contentSha256: contentDigest,
        contentByteLength: bytes.length,
      },
      { abort: invocation.abort, deadlineMs: invocation.deadlineMs },
    ]);
    expect(value.activityCalls[0]).toEqual([
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      invocation.abort,
    ]);
    expect(value.detached).toBe(1);
  });

  test.each([
    [{ sourceVisible: false, targetVisible: true, targetStatus: "busy" }, "caller_not_visible"],
    [{ sourceVisible: true, targetVisible: false, targetStatus: "busy" }, "target_not_visible"],
    [{ sourceVisible: true, targetVisible: true, targetStatus: "idle" }, "target_idle"],
    [{ sourceVisible: true, targetVisible: true, targetStatus: "active" }, "target_status_unknown"],
  ] as const)("admits only currently active targets: %#", async (observation, code) => {
    const value = fixture();
    value.observation = observation as never;
    expect(await sendContextSessionMessage(value.ports, context(), input)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(value.persisted).toEqual([]);
    expect(value.detached).toBe(1);
  });

  test("allows retrying active targets", async () => {
    const value = fixture();
    value.observation = { sourceVisible: true, targetVisible: true, targetStatus: "retry" };
    expect(await sendContextSessionMessage(value.ports, context(), input)).toMatchObject({
      ok: true,
    });
  });

  test.each([
    ["deny", "permission_denied"],
    ["approval_rejected", "approval_rejected"],
    ["malformed", "storage_unavailable"],
  ] as const)("fails closed for authorization outcome %s", async (decision, code) => {
    const value = fixture();
    value.authorization =
      decision === "malformed" ? { kind: "allow", extra: true } : { kind: decision };
    expect(await sendContextSessionMessage(value.ports, context(), input)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(value.persisted).toEqual([]);
  });

  test("maps missing context ports and waiter capacity without persistence", async () => {
    const missing = fixture();
    const { contexts: _contexts, ...portsWithoutContexts } = missing.ports;
    expect(await sendContextSessionMessage(portsWithoutContexts, context(), input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const capacity = fixture();
    capacity.attachThrows = true;
    expect(await sendContextSessionMessage(capacity.ports, context(), input)).toMatchObject({
      ok: false,
      error: { code: "quota_exceeded" },
    });
    expect(capacity.persisted).toEqual([]);
  });

  test.each([
    ["quota_exceeded", "quota_exceeded"],
    ["rate_limited", "rate_limited"],
    ["state_conflict", "storage_unavailable"],
  ] as const)("maps persistence failure %s and detaches", async (storeCode, publicCode) => {
    const value = fixture();
    value.createResult = { ok: false, code: storeCode };
    expect(await sendContextSessionMessage(value.ports, context(), input)).toMatchObject({
      ok: false,
      error: { code: publicCode },
    });
    expect(value.detached).toBe(1);
  });

  test("stops the lifecycle and persists nothing after ownership loss", async () => {
    const value = fixture();
    value.owner = false;
    expect(await sendContextSessionMessage(value.ports, context(), input)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
    expect(value.persisted).toEqual([]);
    expect(value.lifecycleStops).toBe(1);
    expect(value.detached).toBe(1);
  });

  test.each([
    [new ParticipantOperationAbortedFault("aborted"), "deadline_expired"],
    [new ParticipantOperationCapacityFault("full"), "quota_exceeded"],
    [new Error("closed"), "storage_unavailable"],
  ] as const)("maps participant gate faults without leaking them", async (fault, code) => {
    const value = fixture();
    value.gateFault = fault;
    expect(await sendContextSessionMessage(value.ports, context(), input)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(value.detached).toBe(1);
  });

  test("durably cancels when the invocation deadline wins admission", async () => {
    const value = fixture();
    value.currentAdmissions = [admission("awaiting_context"), admission("cancelled")];
    value.registrationOutcome = new Promise(() => undefined);
    expect(
      await sendContextSessionMessage(value.ports, context(undefined, Date.now() + 20), input),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    expect(value.persisted).toHaveLength(1);
    expect(value.detached).toBe(1);
  });

  test("durably cancels when the caller aborts during admission", async () => {
    const value = fixture();
    value.currentAdmissions = [admission("awaiting_context"), admission("cancelled")];
    value.registrationOutcome = new Promise(() => undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    expect(
      await sendContextSessionMessage(value.ports, context(controller, Date.now() + 10_000), input),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
  });

  test("bounds digest and authorization faults before attachment", async () => {
    const digestFailure = fixture();
    digestFailure.ports.digest.sha256 = async () => {
      throw new Error("digest failed");
    };
    expect(await sendContextSessionMessage(digestFailure.ports, context(), input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const authorizationFailure = fixture();
    authorizationFailure.ports.authorization.authorizeMessage = async () => {
      throw new Error("authorization failed");
    };
    expect(
      await sendContextSessionMessage(authorizationFailure.ports, context(), input),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

    const aborted = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await sendContextSessionMessage(aborted.ports, context(controller), input),
    ).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
    expect(aborted.persisted).toEqual([]);
  });
});
