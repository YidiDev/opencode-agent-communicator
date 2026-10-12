import { describe, expect, test } from "bun:test";
import {
  createImmediateSessionRequest,
  type ImmediateSessionRequestPorts,
} from "../../../src/application/create-immediate-session-request";
import type { PrepareRequestInput } from "../../../src/application/request-ports";
import {
  type SessionRequestStartPorts,
  startSessionRequest,
} from "../../../src/application/start-session-request";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid coverage fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:request-race-coverage"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const token = value(validateFencingToken(71));
const requestId = value(validateRequestId(`req_${"1".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"2".repeat(32)}`));
const operationId = value(validateStartOperationId(`op_${"3".repeat(32)}`));
const managedSessionId = value(validateManagedSessionId(`ses_${"4".repeat(32)}`));
const request = { kind: "wait" as const, milestone: "ready", timeoutSeconds: 30 };
const immediateArguments = {
  session_id: targetSessionId,
  content: "Perform the work.",
  request,
};

function immediateFixture() {
  let prepared: PrepareRequestInput | undefined;
  let schedulerWakes = 0;
  let nativeCalls = 0;
  const ports = {
    readiness: { fencingToken: token, assertReady() {} },
    membership: {
      async readCurrentRoots() {
        return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
      },
    },
    messageAuthorization: { authorizeMessage: async () => ({ kind: "allow" as const }) },
    requestAuthorization: { authorizeRequest: async () => ({ kind: "allow" as const }) },
    requests: {
      async createPrepared(input: PrepareRequestInput) {
        prepared = input;
        return { ok: true as const, request: input.request };
      },
      async getRequestMetadata() {
        if (!prepared) throw new Error("request was not prepared");
        return {
          ...prepared.request,
          deliveryState: "context_admitted" as const,
          updatedAtMs: 10_002,
          contextAdmittedAtMs: 10_002,
        } as RequestMetadata;
      },
    },
    scheduler: {
      wake() {
        schedulerWakes += 1;
      },
    },
    nativeQueue: {
      queueMessage: async () => {
        nativeCalls += 1;
        return { kind: "unknown" as const };
      },
    },
    contexts: {
      async getContextAdmission() {
        if (!prepared?.contextAdmission) throw new Error("context was not prepared");
        return {
          id: requestId,
          kind: "request" as const,
          workspaceKey,
          sourceSessionId,
          targetSessionId,
          state: "context_admitted" as const,
          contentByteLength: prepared.contextAdmission.contentByteLength,
          contentSha256: "ab".repeat(32),
          createdAtMs: 10_000,
          updatedAtMs: 10_002,
          awaitingContextAtMs: 10_001,
          contextAdmittedAtMs: 10_002,
          claimedFencingToken: token,
        };
      },
    },
    contextRuntime: {
      effectSignal: new AbortController().signal,
      attach: () => ({
        outcome: Promise.resolve({
          outcome: "settled" as const,
          event: { id: requestId, kind: "request" as const, state: "context_admitted" as const },
        }),
        detach() {},
      }),
      notifyContextSettled: () => undefined,
    },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "busy" as const,
      }),
    },
    participantOperations: {
      async run<Value>(
        _participants: readonly (typeof sourceSessionId)[],
        _abort: AbortSignal,
        operation: () => Promise<Value>,
      ) {
        return operation();
      },
    },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    clock: { nowMs: () => 10_000 },
    ids: {
      requestId: () => requestId,
      nativeMessageId: () => nativeMessageId,
      startOperationId: () => operationId,
    },
    digest: { sha256: async () => new Uint8Array(32).fill(0xab) },
  } as unknown as ImmediateSessionRequestPorts;
  return {
    ports,
    state: {
      get prepared() {
        return prepared;
      },
      get schedulerWakes() {
        return schedulerWakes;
      },
      get nativeCalls() {
        return nativeCalls;
      },
    },
  };
}

function immediateContext(controller = new AbortController(), deadlineMs = 40_000) {
  return {
    workspaceKey,
    sourceSessionId,
    fencingToken: token,
    abort: controller.signal,
    deadlineMs,
  };
}

describe("immediate request deterministic race coverage", () => {
  test("rejects malformed deadline control before invoking a port", async () => {
    const current = immediateFixture();
    expect(
      await createImmediateSessionRequest(
        current.ports,
        immediateContext(undefined, Number.NaN),
        immediateArguments,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(current.state.prepared).toBeUndefined();
  });

  test("bounds a visibility call that loses the caller-abort race", async () => {
    const current = immediateFixture();
    const controller = new AbortController();
    current.ports.membership.readCurrentRoots = () => {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    };

    expect(
      await createImmediateSessionRequest(
        current.ports,
        immediateContext(controller),
        immediateArguments,
      ),
    ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    expect(current.state.prepared).toBeUndefined();
  });

  test("rechecks abort immediately after ownership inspection", async () => {
    const current = immediateFixture();
    const controller = new AbortController();
    current.ports.ownership.isCurrent = async () => {
      controller.abort();
      return true;
    };

    expect(
      await createImmediateSessionRequest(
        current.ports,
        immediateContext(controller),
        immediateArguments,
      ),
    ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    expect(current.state.prepared).toBeUndefined();
  });

  test("leaves an aborted post-persistence request for durable recovery without native I/O", async () => {
    const current = immediateFixture();
    const controller = new AbortController();
    const createPrepared = current.ports.requests.createPrepared.bind(current.ports.requests);
    current.ports.requests.createPrepared = async (input) => {
      const result = await createPrepared(input);
      controller.abort();
      return result;
    };

    expect(
      await createImmediateSessionRequest(
        current.ports,
        immediateContext(controller),
        immediateArguments,
      ),
    ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    expect(current.state.schedulerWakes).toBe(0);
    expect(current.state.nativeCalls).toBe(0);
  });

  test("fails closed when envelope digesting throws after earlier digests succeeded", async () => {
    const current = immediateFixture();
    let calls = 0;
    current.ports.digest.sha256 = async () => {
      calls += 1;
      if (calls >= 3) throw new Error("envelope digest unavailable");
      return new Uint8Array(32).fill(0xab);
    };

    expect(
      await createImmediateSessionRequest(current.ports, immediateContext(), immediateArguments),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(current.state.prepared).toBeUndefined();
  });
});

const startArguments = {
  idempotency_key: "coverage-start-request",
  initial_message: "Build it.",
  request,
};

function earlyStartPorts(recoveredToken: boolean = true): SessionRequestStartPorts {
  return {
    readiness: recoveredToken ? { fencingToken: token, assertReady() {} } : { assertReady() {} },
    policy: createSessionStartPolicy({ decision: "allow" }),
    digest: { sha256: async () => new Uint8Array(32).fill(0xcd) },
    clock: { nowMs: () => 10_000 },
    membership: {
      readCurrentRoots: async () => ({
        sourceVisible: true,
        targetVisible: true,
        sourceTitle: undefined,
      }),
    },
    ids: {
      startOperationId: () => operationId,
      managedSessionId: () => managedSessionId,
      nativeMessageId: () => nativeMessageId,
    },
  } as unknown as SessionRequestStartPorts;
}

describe("session request start early-boundary coverage", () => {
  test("stops at the override policy before payload or effect ports", async () => {
    const ports = earlyStartPorts();
    expect(
      await startSessionRequest(
        ports,
        { ...immediateContext(), deadlineMs: 50_000 },
        { ...startArguments, agent: "general" },
      ),
    ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  test("maps a malformed recovered lifecycle token before recursion or stores", async () => {
    const ports = earlyStartPorts(false);
    expect(
      await startSessionRequest(
        ports,
        { ...immediateContext(), deadlineMs: 50_000 },
        startArguments,
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });
});
