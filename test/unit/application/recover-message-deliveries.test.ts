import { describe, expect, test } from "bun:test";

import type {
  CompleteSubmissionInput,
  DeliveryPersistencePort,
  DeliveryStoreFailureCode,
  DeliveryStoreResult,
  DeliveryTransitionInput,
  NativeQueueAdmission,
  PrepareDeliveryInput,
} from "../../../src/application/delivery-ports";
import {
  classifyStaleMessageDeliveries,
  recoverMessageDeliveries,
  recoverPreparedMessageDeliveries,
} from "../../../src/application/recover-message-deliveries";
import {
  canTransitionDelivery,
  type DeliveryMetadata,
  type DeliveryState,
} from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import {
  type FencingToken,
  OwnershipLostFault,
  validateFencingToken,
} from "../../../src/domain/ownership";
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
  completeFailure: DeliveryStoreFailureCode | undefined;

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
    if (this.completeFailure) return { ok: false as const, code: this.completeFailure };
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
    clockValue: 10,
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
      nowMs: () => ++fixture.clockValue,
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
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(fixture.store.delivery.state).toBe("submitting");
    expect(fixture.store.transitions).toEqual([]);
    expect(fixture.barrierCalls).toBe(0);
  });

  test("stops bounded stale draining when the startup deadline elapses", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      deadlineMs: 11,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(fixture.store.transitions).toEqual([]);
  });

  test("rechecks deadline after prepared membership before claiming", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    ports.membership.readCurrentRoots = async () => {
      fixture.clockValue = 50;
      return { sourceVisible: true, targetVisible: true, sourceTitle: "source" };
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      deadlineMs: 50,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(fixture.store.delivery.state).toBe("prepared");
    expect(fixture.nativeCalls).toEqual([]);
  });

  test("fails closed on malformed prepared recovery metadata", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    fixture.store.delivery = {
      ...fixture.store.delivery,
      contentSha256: "malformed" as Sha256Digest,
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "state_conflict" } });
    expect(fixture.nativeCalls).toEqual([]);
  });

  test("returns ownership_lost when abort arrives after claim and before native admission", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    const controller = new AbortController();
    const claim = ports.deliveries.claimPrepared.bind(ports.deliveries);
    ports.deliveries.claimPrepared = async (input) => {
      const result = await claim(input);
      controller.abort();
      return result;
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: controller.signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(fixture.store.delivery.state).toBe("submitting");
    expect(fixture.nativeCalls).toEqual([]);
  });

  test("does not report recovery success when interrupted during the native effect", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    const controller = new AbortController();
    ports.nativeQueue.queueMessage = async (input) => {
      fixture.nativeCalls.push(input);
      controller.abort();
      return { kind: "admitted", admittedSeq: 71, observedAtMs: 500 };
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: controller.signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(fixture.store.delivery.state).toBe("submitting");
    expect(fixture.nativeCalls).toHaveLength(1);
  });

  test("bounds a never-settling recovery queue effect and observes its late rejection", async () => {
    const { fixture, ports } = recoveryFixture("prepared");
    const controller = new AbortController();
    let reject!: (cause: unknown) => void;
    ports.nativeQueue.queueMessage = (input) => {
      fixture.nativeCalls.push(input);
      return new Promise((_, fail) => (reject = fail));
    };
    const pending = recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: controller.signal,
      limit: 10,
    });
    while (!reject) await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(fixture.store.delivery.state).toBe("submitting");
    reject(new Error("late queue rejection"));
    await Promise.resolve();
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
});

describe("delivery recovery fault and batch handling", () => {
  test("fails closed for prepared list rejection, residual insertion, and descending keysets", async () => {
    const input = {
      workspaceKey,
      fencingToken,
      startupBarrier: { established: true as const, fencingToken },
      abort: new AbortController().signal,
      limit: 10,
    };
    const rejected = recoveryFixture("prepared");
    rejected.ports.deliveries.listRecoverable = async () => {
      throw new Error("prepared list");
    };
    expect(await recoverPreparedMessageDeliveries(rejected.ports, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const residual = recoveryFixture("prepared");
    let residualReads = 0;
    residual.ports.deliveries.listRecoverable = async () =>
      ++residualReads === 1 ? [] : [residual.fixture.store.delivery];
    expect(await recoverPreparedMessageDeliveries(residual.ports, input)).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });

    const descending = recoveryFixture("prepared");
    descending.fixture.targetVisible = true;
    descending.fixture.sourceVisible = true;
    descending.ports.membership.readCurrentRoots = async () => ({
      sourceVisible: true,
      targetVisible: true,
      sourceTitle: "source",
    });
    const later = { ...record("prepared"), createdAtMs: 2, updatedAtMs: 2 };
    const earlier = {
      ...record("prepared"),
      id: valid(validateDeliveryId(`dlv_${"a".repeat(32)}`)),
      nativeMessageId: valid(validateNativeMessageId(`msg_${"b".repeat(32)}`)),
    };
    descending.ports.deliveries.listRecoverable = async () => [later, earlier];
    expect(await recoverPreparedMessageDeliveries(descending.ports, input)).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });

    const ownershipRejected = recoveryFixture("prepared");
    ownershipRejected.ports.deliveries.listRecoverable = async () => {
      throw new OwnershipLostFault("stale");
    };
    expect(await recoverPreparedMessageDeliveries(ownershipRejected.ports, input)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    const interrupted = recoveryFixture("prepared");
    const interruptedController = new AbortController();
    interrupted.ports.deliveries.listRecoverable = () => {
      interruptedController.abort();
      return new Promise(() => undefined);
    };
    expect(
      await recoverPreparedMessageDeliveries(interrupted.ports, {
        ...input,
        abort: interruptedController.signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });

  test("bounds prepared claim/cancel writes and rechecks ownership after a claim", async () => {
    const input = {
      workspaceKey,
      fencingToken,
      startupBarrier: { established: true as const, fencingToken },
      abort: new AbortController().signal,
      limit: 10,
    };
    const claimRejected = recoveryFixture("prepared");
    claimRejected.ports.deliveries.claimPrepared = async () => {
      throw new Error("claim unavailable");
    };
    expect(await recoverPreparedMessageDeliveries(claimRejected.ports, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const cancelRejected = recoveryFixture("prepared");
    cancelRejected.fixture.targetVisible = false;
    cancelRejected.ports.deliveries.cancelPrepared = async () => {
      throw new Error("cancel unavailable");
    };
    expect(await recoverPreparedMessageDeliveries(cancelRejected.ports, input)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const lostAfterClaim = recoveryFixture("prepared");
    let ownershipChecks = 0;
    lostAfterClaim.ports.ownership.isCurrent = async () => ++ownershipChecks === 1;
    expect(await recoverPreparedMessageDeliveries(lostAfterClaim.ports, input)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
  });

  test("maps standalone ownership acquisition rejection without exposing its cause", async () => {
    const { ports } = recoveryFixture("prepared");
    ports.ownership.acquire = async () => {
      throw new Error("secret acquisition cause");
    };
    expect(
      await recoverMessageDeliveries(ports, {
        workspaceKey,
        abort: new AbortController().signal,
        limit: 10,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "storage_unavailable",
        message: "Delivery recovery storage is unavailable.",
        retryable: true,
      },
    });
  });
});

describe("delivery recovery phase controls", () => {
  test("validates standalone shared phase controls and barrier identity", async () => {
    const { ports } = recoveryFixture("prepared");
    const phase = {
      workspaceKey,
      fencingToken,
      startupBarrier: { established: true as const, fencingToken },
      abort: new AbortController().signal,
      limit: 0,
    };
    expect(await classifyStaleMessageDeliveries(ports, phase)).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(
      await classifyStaleMessageDeliveries(ports, {
        ...phase,
        limit: 10,
        startupBarrier: { established: true, fencingToken: staleFencingToken },
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(await recoverPreparedMessageDeliveries(ports, phase)).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    const stopped = new AbortController();
    stopped.abort();
    expect(
      await recoverPreparedMessageDeliveries(ports, {
        ...phase,
        limit: 10,
        abort: stopped.signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(
      await recoverPreparedMessageDeliveries(ports, {
        ...phase,
        limit: 10,
        startupBarrier: { established: true, fencingToken: staleFencingToken },
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });
});

describe("delivery recovery fault and batch handling", () => {
  test("stops when abort arrives after a stale batch read", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    const controller = new AbortController();
    const list = ports.deliveries.listRecoverable.bind(ports.deliveries);
    ports.deliveries.listRecoverable = async (input) => {
      const records = await list(input);
      if (input.state === "submitting") controller.abort();
      return records;
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: controller.signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(fixture.store.transitions).toEqual([]);
  });

  test("fails closed on malformed stale metadata", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    fixture.store.delivery = {
      ...fixture.store.delivery,
      contentSha256: "bad" as Sha256Digest,
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  });

  test("propagates a failed stale classification without reading prepared work", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    fixture.store.completeFailure = "ownership_lost";
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(fixture.store.listInputs.map((input) => input.state)).toEqual(["submitting"]);
  });

  test("rejects a store that reports success without classifying stale state", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    ports.deliveries.completeSubmission = async () => ({
      ok: true,
      delivery: fixture.store.delivery,
    });
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "state_conflict" } });
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

  test("maps the domain ownership fault from a recovery query distinctly", async () => {
    const { ports } = recoveryFixture("prepared");
    ports.deliveries.listRecoverable = async () => {
      throw new OwnershipLostFault("safe ownership loss");
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });

  test("drains limit plus one stale submissions before querying prepared work", async () => {
    const { fixture, ports } = recoveryFixture("submitting");
    const stale = Array.from({ length: 11 }, (_, index) => ({
      ...record("submitting"),
      id: valid(validateDeliveryId(`dlv_${(index + 1).toString(16).padStart(32, "0")}`)),
    }));
    const queryStates: string[] = [];
    ports.deliveries.listRecoverable = async (input) => {
      queryStates.push(input.state);
      return input.state === "submitting" ? stale.slice(0, input.limit) : [];
    };
    ports.deliveries.completeSubmission = async (input) => {
      const index = stale.findIndex((delivery) => delivery.id === input.deliveryId);
      const current = stale[index];
      if (!current) throw new Error("missing stale recovery fixture");
      stale.splice(index, 1);
      return {
        ok: true as const,
        delivery: {
          ...current,
          state: "admission_unknown" as const,
          admissionUnknownAtMs: input.nowMs,
          updatedAtMs: input.nowMs,
        },
      };
    };
    const result = await recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      limit: 10,
    });
    expect(result).toMatchObject({ ok: true, value: { submittingMarkedUnknown: 11 } });
    expect(queryStates).toEqual(["submitting", "submitting", "submitting", "prepared", "prepared"]);
    expect(fixture.nativeCalls).toEqual([]);
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
