import { expect, test } from "bun:test";
import {
  classifyStaleMessageDeliveries,
  recoverPreparedMessageDeliveries,
} from "../../../src/application/recover-message-deliveries";
import {
  classifyStaleSessionRequests,
  expireDueSessionRequests,
  recoverPreparedSessionRequests,
} from "../../../src/application/recover-session-requests";
import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { requestFixture } from "../../support/request-store";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const token = value(validateFencingToken(43));
const workspaceKey = value(validateWorkspaceKey("workspace:critical-recovery"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const deliveryId = value(validateDeliveryId(`dlv_${"d".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"e".repeat(32)}`));
const signal = new AbortController().signal;

function staleDelivery(): DeliveryMetadata {
  return {
    id: deliveryId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId,
    state: "submitting",
    contentByteLength: 2,
    contentSha256: "f".repeat(64) as Sha256Digest,
    createdAtMs: 1,
    submittedAtMs: 2,
    updatedAtMs: 2,
  };
}

const messageInput = {
  workspaceKey,
  fencingToken: token,
  startupBarrier: { established: true as const, fencingToken: token },
  abort: signal,
  deadlineMs: 100,
  limit: 10,
};

function staleMessagePorts(options: {
  readonly current?: () => Promise<boolean>;
  readonly complete?: () => Promise<unknown>;
}) {
  let listed = false;
  return {
    deliveries: {
      async listRecoverable() {
        if (listed) return [];
        listed = true;
        return [staleDelivery()];
      },
      completeSubmission: options.complete ?? (async () => ({})),
    },
    ownership: {
      acquire: async () => token,
      isCurrent: options.current ?? (async () => true),
    },
    membership: { readCurrentRoots: async () => ({}) },
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
    startupBarrier: { establish: async () => messageInput.startupBarrier },
    clock: { nowMs: () => 3 },
  };
}

test("stale delivery classification distinguishes lost and unavailable ownership", async () => {
  expect(
    await classifyStaleMessageDeliveries(
      staleMessagePorts({ current: async () => false }) as never,
      messageInput,
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  for (const cause of [new OwnershipLostFault("stale"), new Error("ownership store")]) {
    expect(
      await classifyStaleMessageDeliveries(
        staleMessagePorts({
          current: async () => {
            throw cause;
          },
        }) as never,
        messageInput,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      },
    });
  }
});

test("stale delivery classification maps rejected completion writes", async () => {
  for (const cause of [new OwnershipLostFault("stale"), new Error("write unavailable")]) {
    expect(
      await classifyStaleMessageDeliveries(
        staleMessagePorts({
          complete: async () => {
            throw cause;
          },
        }) as never,
        messageInput,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      },
    });
  }
});

test("prepared delivery recovery maps an ownership-fault residual probe", async () => {
  expect(
    await recoverPreparedMessageDeliveries(
      {
        ...staleMessagePorts({}),
        deliveries: {
          listRecoverable: async () => {
            throw new OwnershipLostFault("residual fenced");
          },
        },
      } as never,
      messageInput,
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

function requestInput(request: RequestMetadata) {
  return {
    workspaceKey: request.workspaceKey,
    fencingToken: token,
    startupBarrier: { established: true as const, fencingToken: token },
    abort: signal,
    effectSignal: signal,
    deadlineMs: 100,
    limit: 10,
  };
}

function requestBase() {
  return {
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "idle" as const,
      }),
    },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    notifications: { notifyTerminal: () => undefined },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    clock: { nowMs: () => 1 },
  };
}

test("request expiry validates controls and maps a generic rejected write", async () => {
  const fixture = await requestFixture(token, 10);
  const input = requestInput(fixture.request);
  expect(await expireDueSessionRequests({} as never, { ...input, limit: 0 })).toMatchObject({
    ok: false,
    error: { code: "invalid_arguments" },
  });
  expect(
    await expireDueSessionRequests(
      {
        ...requestBase(),
        requests: {
          expireDueRequests: async () => {
            throw new Error("expiry write unavailable");
          },
        },
      } as never,
      input,
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  const stopped = new AbortController();
  stopped.abort();
  expect(
    await expireDueSessionRequests(
      { ...requestBase(), requests: { expireDueRequests: async () => ({}) } } as never,
      { ...input, abort: stopped.signal },
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("stale request classification maps rejected ownership verification", async () => {
  const fixture = await requestFixture(token, 20);
  const stale = {
    ...fixture.request,
    deliveryState: "submitting" as const,
    submittedAtMs: 21,
    updatedAtMs: 21,
  };
  let listed = false;
  expect(
    await classifyStaleSessionRequests(
      {
        ...requestBase(),
        requests: {
          listRecoverableRequests: async () => {
            if (listed) return [];
            listed = true;
            return [stale];
          },
        },
        ownership: {
          acquire: async () => token,
          isCurrent: async () => {
            throw new Error("ownership verification unavailable");
          },
        },
      } as never,
      requestInput(fixture.request),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  expect(
    await classifyStaleSessionRequests(
      {
        ...requestBase(),
        requests: { listRecoverableRequests: async () => [fixture.request] },
      } as never,
      requestInput(fixture.request),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("prepared request recovery contains synchronous native observation faults", async () => {
  const fixture = await requestFixture(token, 30);
  let listed = false;
  expect(
    await recoverPreparedSessionRequests(
      {
        ...requestBase(),
        requests: {
          listRecoverableRequests: async () => {
            if (listed) return [];
            listed = true;
            return [fixture.request];
          },
        },
        activity: {
          observeRequestParticipants() {
            throw new Error("synchronous native adapter fault");
          },
        },
      } as never,
      requestInput(fixture.request),
    ),
  ).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
});
