import { describe, expect, test } from "bun:test";

import type { MessageRecoveryPorts } from "../../../src/application/delivery-ports";
import { recoverMessageDeliveries } from "../../../src/application/recover-message-deliveries-standalone";
import {
  classifyStaleMessageDeliveries,
  recoverPreparedMessageDeliveries,
} from "../../../src/application/recover-message-delivery-phases";
import { recoverOnePreparedMessage } from "../../../src/application/recover-one-prepared-message";
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

const workspaceKey = value(validateWorkspaceKey("workspace:recovery-crashes"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const deliveryId = value(validateDeliveryId(`dlv_${"3".repeat(32)}`));
const secondDeliveryId = value(validateDeliveryId(`dlv_${"4".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"5".repeat(32)}`));
const token = value(validateFencingToken(13));
const staleToken = value(validateFencingToken(12));

function delivery(
  state: "prepared" | "submitting" = "prepared",
  id = deliveryId,
): DeliveryMetadata {
  return {
    id,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId,
    state,
    contentByteLength: 2,
    contentSha256: "b".repeat(64) as Sha256Digest,
    createdAtMs: id === deliveryId ? 1 : 2,
    updatedAtMs: state === "prepared" ? 1 : 2,
    ...(state === "submitting" ? { submittedAtMs: 2 } : {}),
  };
}

function cancelled(record = delivery()): DeliveryMetadata {
  return { ...record, state: "cancelled", cancelledAtMs: 3, updatedAtMs: 3 };
}

function unknown(record = delivery("submitting")): DeliveryMetadata {
  return { ...record, state: "admission_unknown", admissionUnknownAtMs: 3, updatedAtMs: 3 };
}

function ports(): MessageRecoveryPorts {
  return {
    membership: {
      readCurrentRoots: async () => ({
        sourceTitle: "source",
        sourceVisible: true,
        targetVisible: true,
      }),
    },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    startupBarrier: {
      establish: async () => ({ established: true as const, fencingToken: token }),
    },
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
    clock: { nowMs: () => 3 },
    deliveries: {
      listRecoverable: async () => [],
      claimPrepared: async () => ({
        ok: true as const,
        delivery: delivery("submitting"),
        envelope: "{}",
      }),
      cancelPrepared: async () => ({ ok: true as const, delivery: cancelled() }),
      completeSubmission: async () => ({ ok: true as const, delivery: unknown() }),
    } as never,
  };
}

const signal = () => new AbortController().signal;
const phaseInput = (abort = signal()) => ({
  workspaceKey,
  fencingToken: token,
  startupBarrier: { established: true as const, fencingToken: token },
  abort,
  deadlineMs: 100,
  limit: 10,
});

describe("one prepared message recovery", () => {
  test("contains aborted and rejected membership observations", async () => {
    const interrupted = ports();
    const controller = new AbortController();
    interrupted.membership.readCurrentRoots = () => {
      controller.abort();
      return new Promise(() => undefined);
    };
    expect(
      await recoverOnePreparedMessage(
        interrupted,
        workspaceKey,
        token,
        controller.signal,
        100,
        delivery(),
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

    for (const cause of [new OwnershipLostFault("lost"), new Error("native down")]) {
      const rejected = ports();
      rejected.membership.readCurrentRoots = async () => {
        throw cause;
      };
      expect(
        await recoverOnePreparedMessage(rejected, workspaceKey, token, signal(), 100, delivery()),
      ).toMatchObject({
        ok: false,
        error: {
          code: cause instanceof OwnershipLostFault ? "ownership_lost" : "native_unavailable",
        },
      });
    }
  });

  test("fails closed around invisible cancellation writes", async () => {
    const invalidClock = ports();
    invalidClock.membership.readCurrentRoots = async () => ({
      sourceTitle: undefined,
      sourceVisible: false,
      targetVisible: true,
    });
    let clockReads = 0;
    invalidClock.clock.nowMs = () => (++clockReads <= 2 ? 1 : Number.NaN);
    expect(
      await recoverOnePreparedMessage(invalidClock, workspaceKey, token, signal(), 100, delivery()),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

    for (const outcome of [
      async () => {
        throw new OwnershipLostFault("cancel fenced");
      },
      async () => ({ ok: false as const, code: "rate_limited" as const }),
      async () => null,
      async () => ({ ok: true as const, delivery: delivery() }),
    ]) {
      const current = ports();
      current.membership.readCurrentRoots = async () => ({
        sourceTitle: "source",
        sourceVisible: true,
        targetVisible: false,
      });
      current.deliveries.cancelPrepared = outcome as never;
      expect(
        await recoverOnePreparedMessage(current, workspaceKey, token, signal(), 100, delivery()),
      ).toMatchObject({ ok: false });
    }
  });

  test("contains ownership and malformed claim transitions before native work", async () => {
    const lost = ports();
    lost.ownership.isCurrent = async () => false;
    expect(
      await recoverOnePreparedMessage(lost, workspaceKey, token, signal(), 100, delivery()),
    ).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    for (const claim of [
      async () => {
        throw new OwnershipLostFault("claim fenced");
      },
      async () => null,
      async () => ({ ok: false as const, code: "quota_exceeded" as const }),
      async () => ({
        ok: true as const,
        delivery: { ...delivery("submitting"), id: secondDeliveryId },
        envelope: "{}",
      }),
    ]) {
      const current = ports();
      current.deliveries.claimPrepared = claim as never;
      expect(
        await recoverOnePreparedMessage(current, workspaceKey, token, signal(), 100, delivery()),
      ).toMatchObject({ ok: false });
    }

    const skipped = ports();
    skipped.deliveries.claimPrepared = async () => ({ ok: true, delivery: delivery() });
    expect(
      await recoverOnePreparedMessage(skipped, workspaceKey, token, signal(), 100, delivery()),
    ).toEqual({ ok: true, value: "skipped" });
  });

  test("re-fences after a claim and never starts native work after ownership loss", async () => {
    for (const cause of [false, new Error("ownership store")]) {
      const current = ports();
      let checks = 0;
      current.ownership.isCurrent = async () => {
        checks += 1;
        if (checks === 2) {
          if (cause instanceof Error) throw cause;
          return cause;
        }
        return true;
      };
      expect(
        await recoverOnePreparedMessage(current, workspaceKey, token, signal(), 100, delivery()),
      ).toMatchObject({ ok: false });
    }
  });
});

describe("message recovery phase port boundaries", () => {
  test("rejects duplicate stale records and malformed mutation results", async () => {
    const duplicate = ports();
    duplicate.deliveries.listRecoverable = async () => [
      delivery("submitting"),
      delivery("submitting"),
    ];
    expect(await classifyStaleMessageDeliveries(duplicate, phaseInput())).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });

    const malformed = ports();
    let listed = false;
    malformed.deliveries.listRecoverable = async () => {
      if (listed) return [];
      listed = true;
      return [delivery("submitting")];
    };
    malformed.deliveries.completeSubmission = async () => null as never;
    expect(await classifyStaleMessageDeliveries(malformed, phaseInput())).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
  });

  test("bounds stale completion and residual probes on abort", async () => {
    const completion = ports();
    const completionAbort = new AbortController();
    let listed = false;
    completion.deliveries.listRecoverable = async () => {
      if (listed) return [];
      listed = true;
      return [delivery("submitting")];
    };
    completion.deliveries.completeSubmission = () => {
      completionAbort.abort();
      return new Promise(() => undefined);
    };
    expect(
      await classifyStaleMessageDeliveries(completion, phaseInput(completionAbort.signal)),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

    const residual = ports();
    const residualAbort = new AbortController();
    residual.deliveries.listRecoverable = () => {
      residualAbort.abort();
      return new Promise(() => undefined);
    };
    expect(
      await recoverPreparedMessageDeliveries(residual, phaseInput(residualAbort.signal)),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });

  test("fails closed when the clock or residual store disappears between recovery boundaries", async () => {
    const clock = ports();
    let listed = false;
    clock.deliveries.listRecoverable = async () => {
      if (listed) return [];
      listed = true;
      return [delivery("submitting")];
    };
    let clockReads = 0;
    clock.clock.nowMs = () => (++clockReads > 2 ? Number.NaN : 1);
    expect(await classifyStaleMessageDeliveries(clock, phaseInput())).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    for (const cause of [new OwnershipLostFault("probe fenced"), new Error("probe store")]) {
      const probe = ports();
      let reads = 0;
      probe.deliveries.listRecoverable = async () => {
        reads += 1;
        if (reads === 1) return [];
        throw cause;
      };
      expect(await recoverPreparedMessageDeliveries(probe, phaseInput())).toMatchObject({
        ok: false,
        error: {
          code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        },
      });
    }
  });

  test("rejects exotic stale batches before any ownership mutation", async () => {
    for (const records of [
      new Array(1),
      Object.assign([delivery("submitting")], { extra: true }),
    ]) {
      const current = ports();
      current.deliveries.listRecoverable = async () => records;
      expect(await classifyStaleMessageDeliveries(current, phaseInput())).toMatchObject({
        ok: false,
        error: { code: "state_conflict" },
      });
    }
  });

  test("rejects duplicate and malformed prepared batches", async () => {
    const duplicate = ports();
    duplicate.deliveries.listRecoverable = async () => [delivery(), delivery()];
    expect(await recoverPreparedMessageDeliveries(duplicate, phaseInput())).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });

    const sparse = ports();
    sparse.deliveries.listRecoverable = async () => new Array(1);
    expect(await recoverPreparedMessageDeliveries(sparse, phaseInput())).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
  });
});

describe("standalone message recovery lifecycle", () => {
  test("contains invalid timer, barrier interruption, and malformed barrier contracts", async () => {
    const invalidTimer = ports();
    expect(
      await recoverMessageDeliveries(invalidTimer, {
        workspaceKey,
        abort: signal(),
        deadlineMs: 100,
        limit: 10,
        timers: {
          set: () => {
            throw new Error("timer");
          },
          clear() {},
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

    const interrupted = ports();
    const controller = new AbortController();
    interrupted.startupBarrier.establish = () => {
      controller.abort();
      return new Promise(() => undefined);
    };
    expect(
      await recoverMessageDeliveries(interrupted, {
        workspaceKey,
        abort: controller.signal,
        limit: 10,
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

    const malformed = ports();
    malformed.startupBarrier.establish = async () => ({
      established: true,
      fencingToken: staleToken,
    });
    expect(
      await recoverMessageDeliveries(malformed, { workspaceKey, abort: signal(), limit: 10 }),
    ).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  });

  test("distinguishes ownership faults while establishing the startup barrier", async () => {
    for (const cause of [new OwnershipLostFault("barrier fenced"), new Error("barrier store")]) {
      const current = ports();
      current.startupBarrier.establish = async () => {
        throw cause;
      };
      expect(
        await recoverMessageDeliveries(current, { workspaceKey, abort: signal(), limit: 10 }),
      ).toMatchObject({
        ok: false,
        error: {
          code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        },
      });
    }
  });

  test("stops between stale and prepared phases when the absolute deadline elapses", async () => {
    const current = ports();
    let now = 1;
    current.clock.nowMs = () => now;
    current.deliveries.listRecoverable = async (query) => {
      if (query.state === "submitting") now = 10;
      return [];
    };
    expect(
      await recoverMessageDeliveries(current, {
        workspaceKey,
        abort: signal(),
        deadlineMs: 10,
        limit: 10,
        timers: { set: () => 1, clear() {} },
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });
});
