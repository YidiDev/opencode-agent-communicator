import { describe, expect, test } from "bun:test";

import type {
  CompleteSubmissionInput,
  DeliveryPersistencePort,
  DeliveryStoreResult,
  DeliveryTransitionInput,
  NativeQueueAdmission,
  PrepareDeliveryInput,
} from "../../../src/application/delivery-ports";
import { recoverMessageDeliveries } from "../../../src/application/recover-message-deliveries";
import {
  canTransitionDelivery,
  type DeliveryMetadata,
  type DeliveryState,
} from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { type FencingToken, validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:recovery"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const deliveryId = valid(validateDeliveryId(`dlv_${"d".repeat(32)}`));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"e".repeat(32)}`));
const fencingToken = valid(validateFencingToken(17));
const staleFencingToken = valid(validateFencingToken(16));

function record(state: DeliveryState): DeliveryMetadata {
  return {
    id: deliveryId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId,
    state,
    contentByteLength: 7,
    contentSha256: "f".repeat(64) as Sha256Digest,
    createdAtMs: 1,
    updatedAtMs: 2,
    ...(state === "submitting" ? { submittedAtMs: 2 } : {}),
  };
}

class RecoveryStore implements DeliveryPersistencePort {
  delivery: DeliveryMetadata;
  envelope: string | undefined;
  readonly transitions: DeliveryState[] = [];
  readonly listInputs: Array<Parameters<DeliveryPersistencePort["listRecoverable"]>[0]> = [];
  claimedByToken: FencingToken | undefined;

  constructor(state: "prepared" | "submitting") {
    this.delivery = record(state);
    this.envelope = state === "prepared" ? '{"verified":"envelope"}' : undefined;
    this.claimedByToken = state === "submitting" ? staleFencingToken : undefined;
  }

  private checkToken(token: FencingToken): void {
    expect(token).toBe(fencingToken);
  }

  async createPrepared(_input: PrepareDeliveryInput): Promise<DeliveryStoreResult> {
    throw new Error("not used");
  }

  async cancelPrepared(input: DeliveryTransitionInput) {
    this.checkToken(input.fencingToken);
    if (this.delivery.state === "prepared") {
      this.delivery = {
        ...this.delivery,
        state: "cancelled",
        updatedAtMs: input.nowMs,
        cancelledAtMs: input.nowMs,
      };
      this.envelope = undefined;
    }
    return { ok: true as const, delivery: this.delivery };
  }

  async claimPrepared(input: DeliveryTransitionInput) {
    this.checkToken(input.fencingToken);
    if (this.delivery.state !== "prepared" || this.envelope === undefined) {
      return { ok: true as const, delivery: this.delivery };
    }
    const envelope = this.envelope;
    this.envelope = undefined;
    this.delivery = {
      ...this.delivery,
      state: "submitting",
      submittedAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    this.claimedByToken = input.fencingToken;
    this.transitions.push("submitting");
    return {
      ok: true as const,
      delivery: this.delivery as DeliveryMetadata & { readonly state: "submitting" },
      envelope,
    };
  }

  async completeSubmission(input: CompleteSubmissionInput) {
    this.checkToken(input.fencingToken);
    const legal =
      canTransitionDelivery(this.delivery.state, input.state) ||
      (this.delivery.state === "submitting" && input.state === "promoted");
    expect(legal).toBe(true);
    const transitionAtMs =
      input.state === "admitted" || input.state === "promoted"
        ? Math.max(input.nowMs, input.evidenceObservedAtMs)
        : input.nowMs;
    if (input.state === "admission_unknown") {
      this.delivery = {
        ...this.delivery,
        state: input.state,
        admissionUnknownAtMs: transitionAtMs,
        updatedAtMs: transitionAtMs,
      };
    } else if (input.state === "admitted") {
      this.delivery = {
        ...this.delivery,
        state: input.state,
        admittedAtMs: transitionAtMs,
        admissionEvidence: {
          nativeMessageId,
          state: "admitted",
          admittedSeq: input.admittedSeq,
          observedAtMs: input.evidenceObservedAtMs,
        },
        updatedAtMs: transitionAtMs,
      };
    } else if (input.state === "promoted") {
      this.delivery = {
        ...this.delivery,
        state: input.state,
        admittedAtMs: transitionAtMs,
        promotedAtMs: transitionAtMs,
        admissionEvidence: {
          nativeMessageId,
          state: "promoted",
          admittedSeq: input.admittedSeq,
          promotedSeq: input.promotedSeq,
          observedAtMs: input.evidenceObservedAtMs,
        },
        updatedAtMs: transitionAtMs,
      };
    } else {
      this.delivery = {
        ...this.delivery,
        state: "failed",
        failedAtMs: transitionAtMs,
        updatedAtMs: transitionAtMs,
      };
    }
    this.transitions.push(input.state);
    return { ok: true as const, delivery: this.delivery };
  }

  async listRecoverable(input: Parameters<DeliveryPersistencePort["listRecoverable"]>[0]) {
    this.checkToken(input.fencingToken);
    this.listInputs.push(input);
    if (input.state === "submitting") {
      expect(input.startupBarrier).toEqual({ established: true, fencingToken });
      expect(input.excludeClaimedByToken).toBe(fencingToken);
      if (this.claimedByToken === input.excludeClaimedByToken) return [];
    }
    return this.delivery.state === input.state ? [this.delivery] : [];
  }

  async getForParticipant() {
    return undefined;
  }
}

function recoveryFixture(state: "prepared" | "submitting") {
  const store = new RecoveryStore(state);
  const nativeCalls: Array<{ envelope: string; abort: AbortSignal }> = [];
  const fixture = {
    outcome: { kind: "admitted", admittedSeq: 71, observedAtMs: 500 } as NativeQueueAdmission,
    store,
    nativeCalls,
    sourceVisible: true,
    targetVisible: true,
    membershipError: false,
    acquireCalls: 0,
    barrierCalls: 0,
    ownerCurrent: true,
  };
  const ports = {
    deliveries: store,
    membership: {
      async readCurrentRoots() {
        if (fixture.membershipError) throw new Error("membership unavailable");
        return {
          sourceVisible: fixture.sourceVisible,
          targetVisible: fixture.targetVisible,
          sourceTitle: "source",
        };
      },
    },
    nativeQueue: {
      async queueMessage(input: { readonly envelope: string; readonly abort: AbortSignal }) {
        nativeCalls.push(input);
        return fixture.outcome;
      },
    },
    ownership: {
      async acquire() {
        fixture.acquireCalls += 1;
        return fencingToken;
      },
      async isCurrent(token: FencingToken) {
        expect(token).toBe(fencingToken);
        return fixture.ownerCurrent;
      },
    },
    startupBarrier: {
      async establish(token: FencingToken) {
        fixture.barrierCalls += 1;
        expect(token).toBe(fencingToken);
        return { established: true as const, fencingToken: token };
      },
    },
    clock: {
      nowMs: (() => {
        let value = 10;
        return () => ++value;
      })(),
    },
  };
  return { fixture, ports };
}

describe("delivery crash recovery", () => {
  test("claims a recovered prepared envelope, erases it, and performs its first submission once", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    const controller = new AbortController();
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: controller.signal,
      limit: 10,
    });
    expect(result).toEqual({
      ok: true,
      value: { submittingMarkedUnknown: 0, preparedSubmitted: 1, preparedCancelled: 0 },
    });
    expect(fixture.nativeCalls).toHaveLength(1);
    expect(fixture.nativeCalls[0]).toMatchObject({
      envelope: '{"verified":"envelope"}',
      abort: controller.signal,
    });
    expect(fixture.store.envelope).toBeUndefined();
    expect(fixture.store.delivery.state).toBe("admitted");
    expect(fixture.store.transitions).toEqual(["submitting", "admitted"]);
    expect(fixture.acquireCalls).toBe(1);
    expect(fixture.barrierCalls).toBe(1);

    await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: controller.signal,
      limit: 10,
    });
    expect(fixture.nativeCalls).toHaveLength(1);
  });

  test("converts recovered submitting to admission_unknown without native resubmission", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: true, value: { submittingMarkedUnknown: 1 } });
    expect(fixture.store.delivery.state).toBe("admission_unknown");
    expect(fixture.nativeCalls).toEqual([]);
    expect(fixture.store.listInputs[0]).toMatchObject({
      state: "submitting",
      fencingToken,
      excludeClaimedByToken: fencingToken,
      startupBarrier: { established: true, fencingToken },
    });
  });

  test("startup recovery cannot mark work claimed by its current fencing token unknown", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    fixture.store.claimedByToken = fencingToken;
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: true, value: { submittingMarkedUnknown: 0 } });
    expect(fixture.store.delivery.state).toBe("submitting");
    expect(fixture.nativeCalls).toEqual([]);
  });

  test("checks operation abort before each recovery mutation", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    const controller = new AbortController();
    controller.abort();
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: controller.signal,
      deadlineMs: 99,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: true, value: { submittingMarkedUnknown: 0 } });
    expect(fixture.store.delivery.state).toBe("submitting");
    expect(fixture.store.transitions).toEqual([]);
    expect(fixture.barrierCalls).toBe(1);
  });

  test("fails with safe delivery correlation when fencing ownership is stale", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    fixture.ownerCurrent = false;
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ownership_lost", details: { delivery_id: deliveryId } },
    });
    expect(fixture.store.delivery.state).toBe("submitting");
  });

  test("maps recovery list storage faults without leaking details", async () => {
    const { ports } = recoveryFixture("prepared");
    ports.deliveries.listRecoverable = async () => {
      throw new Error("private database detail");
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "storage_unavailable",
        message: "Delivery recovery storage is unavailable.",
        retryable: true,
      },
    });
  });

  test("never resubmits a recovered prepared delivery after an ambiguous native attempt", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    fixture.outcome = { kind: "unknown" };
    const input = { workspaceKey, abort: new AbortController().signal, limit: 10 };
    await recoverMessageDeliveries(ports, input);
    await recoverMessageDeliveries(ports, input);
    expect(fixture.store.delivery.state).toBe("admission_unknown");
    expect(fixture.nativeCalls).toHaveLength(1);
  });

  test("cancels prepared recovery if either participant is no longer visible", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    fixture.targetVisible = false;
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: true, value: { preparedCancelled: 1 } });
    expect(fixture.store.delivery.state).toBe("cancelled");
    expect(fixture.nativeCalls).toEqual([]);
  });

  test("rejects invalid recovery bounds before store access", async () => {
    const { ports } = recoveryFixture("prepared");
    expect(
      await recoverMessageDeliveries(ports, {
        workspaceKey,
        abort: new AbortController().signal,
        limit: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  test("leaves prepared work untouched when current membership is unavailable", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    fixture.membershipError = true;
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(fixture.store.delivery.state).toBe("prepared");
    expect(fixture.nativeCalls).toEqual([]);
  });
});
