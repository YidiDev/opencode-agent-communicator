import { describe, expect, test } from "bun:test";

import {
  admitClaimedMessage,
  deliveryStoreFailure,
  type MessageAdmissionPorts,
} from "../../../src/application/admit-message-delivery";
import { boundedExternalCall } from "../../../src/application/bounded-external-call";
import {
  inspectDeliveryMetadata,
  inspectDeliveryMutation,
  inspectMembership,
} from "../../../src/application/message-recovery-boundaries";
import { observeNativePromiseRejection } from "../../../src/application/native-promise-observation";
import {
  createLinkedEffectControl,
  createLinkedStartupEffectControl,
} from "../../../src/application/startup-effect-control";
import {
  snapshotDataRecord,
  snapshotDenseArray,
} from "../../../src/application/strict-port-boundaries";
import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:application-boundaries"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const deliveryId = value(validateDeliveryId(`dlv_${"1".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"2".repeat(32)}`));
const token = value(validateFencingToken(9));

function submitting(): DeliveryMetadata {
  return {
    id: deliveryId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId,
    state: "submitting",
    contentByteLength: 2,
    contentSha256: "a".repeat(64) as Sha256Digest,
    createdAtMs: 1,
    submittedAtMs: 2,
    updatedAtMs: 2,
  };
}

function admissionPorts(
  overrides: Partial<{
    current: () => Promise<boolean>;
    queue: () => Promise<never>;
    complete: () => Promise<unknown>;
    now: () => number;
  }> = {},
): MessageAdmissionPorts {
  return {
    ownership: {
      acquire: async () => token,
      isCurrent: overrides.current ?? (async () => true),
    },
    nativeQueue: {
      queueMessage:
        overrides.queue ??
        (async () => ({ kind: "promoted", admittedSeq: -1, promotedSeq: 0, observedAtMs: -1 })),
    },
    deliveries: {
      completeSubmission:
        overrides.complete ?? (async () => ({ ok: true, delivery: submitting() })),
    } as never,
    clock: { nowMs: overrides.now ?? (() => 3) },
  };
}

async function admit(
  ports: MessageAdmissionPorts,
  control: { abort?: AbortSignal; deadlineMs?: number } = {},
) {
  return admitClaimedMessage(ports, {
    workspaceKey,
    fencingToken: token,
    delivery: submitting(),
    envelope: "{}",
    abort: control.abort ?? new AbortController().signal,
    interruptionMeansOwnershipLoss: true,
    ...(control.deadlineMs === undefined ? {} : { deadlineMs: control.deadlineMs }),
  });
}

describe("bounded and hostile application boundaries", () => {
  test("expires before invoking external work and at the final pre-call race check", async () => {
    let called = false;
    const stopped = new AbortController();
    stopped.abort();
    expect(
      await boundedExternalCall(() => (called = true), stopped.signal, Date.now() + 100),
    ).toEqual({
      kind: "expired",
    });
    expect(called).toBe(false);

    let reads = 0;
    const racing = {
      get aborted() {
        reads += 1;
        return reads > 1;
      },
    } as AbortSignal;
    expect(await boundedExternalCall(() => (called = true), racing, Date.now() + 100)).toEqual({
      kind: "expired",
    });
    expect(called).toBe(false);
  });

  test("contains synchronous external rejection and observes native promises only", async () => {
    const fault = new Error("sync external fault");
    expect(
      await boundedExternalCall(
        () => {
          throw fault;
        },
        new AbortController().signal,
        Date.now() + 100,
      ),
    ).toEqual({ kind: "rejected", cause: fault });
    observeNativePromiseRejection(undefined);
    observeNativePromiseRejection(null);
    observeNativePromiseRejection(() => undefined);
    // biome-ignore lint/suspicious/noThenProperty: a non-native thenable is the boundary under test.
    observeNativePromiseRejection({ then: () => undefined });
  });

  test("rejects exotic records and sparse or accessor arrays without invoking getters", () => {
    expect(snapshotDataRecord(Object.create(Date.prototype), 1)).toBeUndefined();
    expect(snapshotDataRecord({ a: 1, b: 2 }, 1)).toBeUndefined();
    expect(
      snapshotDataRecord(Object.defineProperty({}, "a", { enumerable: true, get: () => 1 }), 1),
    ).toBeUndefined();

    const sparse = new Array(1);
    expect(snapshotDenseArray(sparse, 1)).toBeUndefined();
    expect(snapshotDenseArray([1, 2], 1)).toBeUndefined();
    expect(
      snapshotDenseArray(Object.defineProperty([], "0", { enumerable: true, get: () => 1 }), 1),
    ).toBeUndefined();
  });

  test("rejects malformed delivery, membership, and mutation snapshots", () => {
    expect(inspectDeliveryMetadata({ ...submitting(), state: "future" })).toBeUndefined();
    expect(inspectDeliveryMetadata({ ...submitting(), extra: true })).toBeUndefined();
    expect(
      inspectDeliveryMetadata({
        ...submitting(),
        state: "admitted",
        admittedAtMs: 3,
        admissionEvidence: { state: "admitted", nativeMessageId, admittedSeq: 1 },
      }),
    ).toBeUndefined();
    expect(
      inspectMembership({ sourceTitle: 1, sourceVisible: true, targetVisible: true }),
    ).toBeUndefined();
    expect(inspectDeliveryMutation(null)).toBeUndefined();
    expect(inspectDeliveryMutation({ ok: false, code: "future" })).toBeUndefined();
    expect(
      inspectDeliveryMutation({ ok: true, delivery: submitting(), envelope: 7 }),
    ).toBeUndefined();
  });
});

describe("claimed message crash boundaries", () => {
  test("normalizes incoherent native evidence and rejects malformed completion metadata", async () => {
    expect(await admit(admissionPorts())).toMatchObject({
      ok: false,
      error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
    });
    expect(
      await admit(
        admissionPorts({ complete: async () => ({ ok: false, code: "quota_exceeded" }) }),
      ),
    ).toMatchObject({ ok: false, error: { code: "quota_exceeded" } });
    expect(await admit(admissionPorts({ complete: async () => null }))).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
  });

  test("maps interruption and ownership faults at each claimed-effect fence", async () => {
    const alreadyStopped = new AbortController();
    alreadyStopped.abort();
    expect(await admit(admissionPorts(), { abort: alreadyStopped.signal })).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    let checks = 0;
    expect(
      await admit(
        admissionPorts({
          current: async () => {
            checks += 1;
            if (checks === 2) throw new OwnershipLostFault("post-effect fence lost");
            return true;
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

    const duringQueue = new AbortController();
    expect(
      await admit(
        admissionPorts({
          queue: () => {
            duringQueue.abort();
            return new Promise(() => undefined);
          },
        }),
        { abort: duringQueue.signal },
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

    expect(
      await admit(
        admissionPorts({
          queue: async () => {
            throw new OwnershipLostFault("queue promise fenced");
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

    const duringCompletion = new AbortController();
    expect(
      await admit(
        admissionPorts({
          complete: () => {
            duringCompletion.abort();
            return new Promise(() => undefined);
          },
        }),
        { abort: duringCompletion.signal },
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });

  test("keeps retryability and correlation behavior explicit for store failures", () => {
    expect(deliveryStoreFailure("rate_limited")).toMatchObject({
      ok: false,
      error: { retryable: true },
    });
    expect(deliveryStoreFailure("state_conflict", deliveryId)).toMatchObject({
      ok: false,
      error: { retryable: false, details: { delivery_id: deliveryId } },
    });
  });
});

test("linked controls fail closed when a deadline contract mutates while arming", () => {
  const signal = new AbortController().signal;
  let reads = 0;
  const input = {
    signals: [signal],
    get deadlineMs() {
      reads += 1;
      return reads < 5 ? 10 : undefined;
    },
    clock: { nowMs: () => 1 },
    timers: { set: () => 1, clear() {} },
  };
  const control = createLinkedEffectControl(
    input as unknown as Parameters<typeof createLinkedEffectControl>[0],
  );
  expect(control?.signal.aborted).toBe(true);
  control?.dispose();

  const startup = createLinkedStartupEffectControl({
    caller: signal,
    runtime: signal,
    deadlineMs: 2,
    clock: { nowMs: () => 2 },
  });
  expect(startup?.signal.aborted).toBe(true);

  let deadlineReads = 0;
  const expiring = createLinkedEffectControl({
    signals: [signal],
    get deadlineMs() {
      deadlineReads += 1;
      return deadlineReads < 5 ? 10 : 1;
    },
    clock: { nowMs: () => 1 },
    timers: { set: () => 1, clear() {} },
  });
  expect(expiring?.signal.aborted).toBe(true);
});
