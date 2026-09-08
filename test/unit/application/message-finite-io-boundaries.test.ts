import { describe, expect, jest, test } from "bun:test";

import {
  admitClaimedMessage,
  type MessageAdmissionPorts,
} from "../../../src/application/admit-message-delivery";
import type { SessionSendPorts } from "../../../src/application/send-session-message";
import { sendSessionMessage as sendApplicationSessionMessage } from "../../../src/application/send-session-message";
import type { DeliveryMetadata, DeliveryState } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { deferred } from "../../support/blocking-request-fixture";

const sendSessionMessage = (
  ...input: Parameters<typeof sendApplicationSessionMessage>
): ReturnType<typeof sendApplicationSessionMessage> => {
  const [ports, context, args] = input;
  return sendApplicationSessionMessage(ports, context, { ...args, delivery: "user" });
};

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:finite-message-io"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const deliveryId = value(validateDeliveryId(`dlv_${"d".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"e".repeat(32)}`));
const fencingToken = value(validateFencingToken(29));

function delivery(state: DeliveryState = "prepared"): DeliveryMetadata {
  const base = {
    id: deliveryId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId,
    contentByteLength: 4,
    contentSha256: "f".repeat(64) as Sha256Digest,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  if (state === "prepared") return { ...base, state };
  if (state === "submitting") return { ...base, state, submittedAtMs: 2 };
  if (state === "cancelled") return { ...base, state, cancelledAtMs: 2 };
  if (state === "failed") return { ...base, state, submittedAtMs: 2, failedAtMs: 2 };
  if (state === "admission_unknown") {
    return { ...base, state, submittedAtMs: 2, admissionUnknownAtMs: 2 };
  }
  if (state === "admitted") {
    return {
      ...base,
      state,
      submittedAtMs: 2,
      admittedAtMs: 2,
      admissionEvidence: {
        nativeMessageId,
        state,
        admittedSeq: 1,
        observedAtMs: 2,
      },
    };
  }
  return {
    ...base,
    state,
    submittedAtMs: 2,
    admittedAtMs: 2,
    promotedAtMs: 2,
    admissionEvidence: {
      nativeMessageId,
      state,
      admittedSeq: 1,
      promotedSeq: 2,
      observedAtMs: 2,
    },
  };
}

const never = <Value>(): Promise<Value> => new Promise(() => undefined);
const deadlineContext = (
  abort = new AbortController().signal,
  deadlineMs = Date.now() + 60_000,
) => ({
  workspaceKey,
  sourceSessionId,
  abort,
  deadlineMs,
});
const args = { session_id: targetSessionId, content: "work" };

function pendingOperation<Value>() {
  const started = deferred<void>();
  return {
    started: started.promise,
    operation: () => {
      started.resolve();
      return never<Value>();
    },
  };
}

async function expireAtControlledDeadline<Value>(
  started: Promise<void>,
  operation: (deadlineMs: number) => Promise<Value>,
): Promise<Value> {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(10_000);
    const pending = operation(10_015);
    await started;
    jest.advanceTimersByTime(15);
    return await pending;
  } finally {
    jest.useRealTimers();
  }
}

function sendFixture() {
  let membershipReads = 0;
  let ownershipReads = 0;
  let cancellations = 0;
  const completions: string[] = [];
  const state = {
    membership: async () => {
      return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
    },
    ownership: async () => {
      return true;
    },
  };
  const ports: SessionSendPorts = {
    readiness: { fencingToken, assertReady() {}, ownershipLost() {} },
    membership: {
      readCurrentRoots: () => {
        membershipReads += 1;
        return state.membership();
      },
    },
    authorization: { authorizeMessage: async () => ({ kind: "allow" }) },
    ownership: {
      acquire: async () => fencingToken,
      isCurrent: () => {
        ownershipReads += 1;
        return state.ownership();
      },
    },
    clock: { nowMs: () => 2 },
    ids: {
      deliveryId: () => deliveryId,
      nativeMessageId: () => nativeMessageId,
    } as never,
    digest: { sha256: async () => new Uint8Array(32).fill(0xff) },
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" }) },
    deliveries: {
      createPrepared: async () => ({ ok: true, delivery: delivery() }),
      cancelPrepared: async () => {
        cancellations += 1;
        return { ok: true, delivery: delivery("cancelled") };
      },
      claimPrepared: async () => ({
        ok: true,
        delivery: delivery("submitting"),
        envelope: "{}",
      }),
      completeSubmission: async (
        input: Parameters<SessionSendPorts["deliveries"]["completeSubmission"]>[0],
      ) => {
        completions.push(input.state);
        return { ok: true, delivery: delivery(input.state) };
      },
    } as unknown as SessionSendPorts["deliveries"],
  };
  return {
    ports,
    state,
    completions,
    membershipReads: () => membershipReads,
    ownershipReads: () => ownershipReads,
    cancellations: () => cancellations,
  };
}

describe("session send finite I/O boundaries", () => {
  test("bounds a nonsettling initial ownership read before persistence", async () => {
    const fixture = sendFixture();
    const boundary = pendingOperation<boolean>();
    fixture.state.ownership = boundary.operation;
    const result = await expireAtControlledDeadline(boundary.started, (deadlineMs) =>
      sendSessionMessage(fixture.ports, deadlineContext(undefined, deadlineMs), args),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    expect(fixture.membershipReads()).toBe(1);
    expect(fixture.cancellations()).toBe(0);
  });

  test("fails closed when the initial ownership read rejects", async () => {
    const fixture = sendFixture();
    fixture.state.ownership = async () => {
      throw new Error("ownership unavailable");
    };
    expect(
      await sendSessionMessage(
        fixture.ports,
        { workspaceKey, sourceSessionId, abort: new AbortController().signal },
        args,
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });

  test.each(["membership", "authorization"] as const)(
    "bounds rejected and nonsettling %s I/O",
    async (boundary) => {
      const rejected = sendFixture();
      if (boundary === "membership") {
        rejected.state.membership = async () => {
          throw new Error("membership unavailable");
        };
      } else {
        rejected.ports.authorization.authorizeMessage = async () => {
          throw new Error("authorization unavailable");
        };
      }
      expect(await sendSessionMessage(rejected.ports, deadlineContext(), args)).toMatchObject({
        ok: false,
        error: { code: boundary === "membership" ? "native_unavailable" : "storage_unavailable" },
      });

      const pending = sendFixture();
      const operation = pendingOperation<never>();
      if (boundary === "membership") pending.state.membership = operation.operation;
      else pending.ports.authorization.authorizeMessage = operation.operation;
      const result = await expireAtControlledDeadline(operation.started, (deadlineMs) =>
        sendSessionMessage(pending.ports, deadlineContext(undefined, deadlineMs), args),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "deadline_expired" },
      });
    },
  );

  test("cancels cleanly when final membership does not settle", async () => {
    const fixture = sendFixture();
    const boundary = pendingOperation<never>();
    fixture.state.membership = async () => {
      if (fixture.membershipReads() === 3) return boundary.operation();
      return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
    };
    const result = await expireAtControlledDeadline(boundary.started, (deadlineMs) =>
      sendSessionMessage(fixture.ports, deadlineContext(undefined, deadlineMs), args),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
    expect(fixture.cancellations()).toBe(1);
  });

  test.each(["rejected", "nonsettling"] as const)(
    "cancels prepared work when pre-claim ownership is %s",
    async (mode) => {
      const fixture = sendFixture();
      const boundary = pendingOperation<boolean>();
      fixture.state.ownership = async () => {
        if (fixture.ownershipReads() === 2) {
          if (mode === "rejected") throw new Error("ownership unavailable");
          return boundary.operation();
        }
        return true;
      };
      const result =
        mode === "nonsettling"
          ? await expireAtControlledDeadline(boundary.started, (deadlineMs) =>
              sendSessionMessage(fixture.ports, deadlineContext(undefined, deadlineMs), args),
            )
          : await sendSessionMessage(
              fixture.ports,
              { workspaceKey, sourceSessionId, abort: new AbortController().signal },
              args,
            );
      expect(result).toMatchObject({
        ok: false,
        error: { code: mode === "rejected" ? "ownership_lost" : "deadline_expired" },
      });
      expect(fixture.cancellations()).toBe(1);
    },
  );

  test.each(["rejected", "nonsettling"] as const)(
    "does not misreport an uncertain %s claim as clean cancellation",
    async (mode) => {
      const fixture = sendFixture();
      const boundary = pendingOperation<never>();
      fixture.ports.deliveries.claimPrepared =
        mode === "rejected"
          ? async () => {
              throw new Error("claim unavailable");
            }
          : boundary.operation;
      const result =
        mode === "nonsettling"
          ? await expireAtControlledDeadline(boundary.started, (deadlineMs) =>
              sendSessionMessage(fixture.ports, deadlineContext(undefined, deadlineMs), args),
            )
          : await sendSessionMessage(
              fixture.ports,
              { workspaceKey, sourceSessionId, abort: new AbortController().signal },
              args,
            );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
      });
      expect(fixture.cancellations()).toBe(1);
      expect(fixture.completions).toEqual([]);
    },
  );
});

describe("session send settlement boundaries", () => {
  test("records a late successful uncertain claim as admission_unknown", async () => {
    const fixture = sendFixture();
    const claimStarted = deferred<void>();
    const completionRecorded = deferred<void>();
    const completeSubmission = fixture.ports.deliveries.completeSubmission;
    fixture.ports.deliveries.completeSubmission = async (input) => {
      const result = await completeSubmission(input);
      completionRecorded.resolve();
      return result;
    };
    let settleClaim:
      | ((value: Awaited<ReturnType<SessionSendPorts["deliveries"]["claimPrepared"]>>) => void)
      | undefined;
    fixture.ports.deliveries.claimPrepared = () =>
      new Promise((resolve) => {
        claimStarted.resolve();
        settleClaim = resolve;
      });

    const result = await expireAtControlledDeadline(claimStarted.promise, (deadlineMs) =>
      sendSessionMessage(fixture.ports, deadlineContext(undefined, deadlineMs), args),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
    });
    settleClaim?.({
      ok: true,
      delivery: delivery("submitting") as DeliveryMetadata & { readonly state: "submitting" },
      envelope: "{}",
    });
    await completionRecorded.promise;
    expect(fixture.completions).toContain("admission_unknown");
  });

  test.each(["digest", "prepare"] as const)("bounds nonsettling %s I/O", async (boundary) => {
    const fixture = sendFixture();
    const operation = pendingOperation<never>();
    if (boundary === "digest") fixture.ports.digest.sha256 = operation.operation;
    else fixture.ports.deliveries.createPrepared = operation.operation;
    const result = await expireAtControlledDeadline(operation.started, (deadlineMs) =>
      sendSessionMessage(fixture.ports, deadlineContext(undefined, deadlineMs), args),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
  });

  test.each(["digest", "authorization", "prepare"] as const)(
    "contains rejected %s I/O without an invocation deadline",
    async (boundary) => {
      const fixture = sendFixture();
      const cancelled = deferred<void>();
      const cancelPrepared = fixture.ports.deliveries.cancelPrepared;
      fixture.ports.deliveries.cancelPrepared = async (input) => {
        const result = await cancelPrepared(input);
        cancelled.resolve();
        return result;
      };
      if (boundary === "digest") {
        fixture.ports.digest.sha256 = async () => {
          throw new Error("digest rejected");
        };
      } else if (boundary === "authorization") {
        fixture.ports.authorization.authorizeMessage = async () => {
          throw new Error("authorization rejected");
        };
      } else {
        fixture.ports.deliveries.createPrepared = async () => {
          throw new Error("prepare rejected");
        };
      }
      expect(
        await sendSessionMessage(
          fixture.ports,
          { workspaceKey, sourceSessionId, abort: new AbortController().signal },
          args,
        ),
      ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
      if (boundary === "prepare") {
        await cancelled.promise;
        expect(fixture.cancellations()).toBe(1);
      }
    },
  );

  test.each(["rejected", "malformed", "wrong-state"] as const)(
    "contains %s prepared cancellation settlement",
    async (mode) => {
      const fixture = sendFixture();
      fixture.state.membership = async () => {
        if (fixture.membershipReads() === 3) throw new Error("membership unavailable");
        return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
      };
      fixture.ports.deliveries.cancelPrepared =
        mode === "rejected"
          ? async () => {
              throw new Error("cancellation rejected");
            }
          : mode === "malformed"
            ? async () => null as never
            : async () => ({ ok: true, delivery: delivery("prepared") });
      expect(
        await sendSessionMessage(
          fixture.ports,
          { workspaceKey, sourceSessionId, abort: new AbortController().signal },
          args,
        ),
      ).toMatchObject({ ok: false });
    },
  );

  test("cancels immediately and again when preparation settles after expiry", async () => {
    const fixture = sendFixture();
    const preparationStarted = deferred<void>();
    const secondCancellation = deferred<void>();
    const cancelPrepared = fixture.ports.deliveries.cancelPrepared;
    fixture.ports.deliveries.cancelPrepared = async (input) => {
      const result = await cancelPrepared(input);
      if (fixture.cancellations() === 2) secondCancellation.resolve();
      return result;
    };
    let release: (() => void) | undefined;
    fixture.ports.deliveries.createPrepared = () =>
      new Promise((resolve) => {
        preparationStarted.resolve();
        release = () => resolve({ ok: true, delivery: delivery() });
      });
    const result = await expireAtControlledDeadline(preparationStarted.promise, (deadlineMs) =>
      sendSessionMessage(fixture.ports, deadlineContext(undefined, deadlineMs), args),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    expect(fixture.cancellations()).toBe(1);
    release?.();
    await secondCancellation.promise;
    expect(fixture.cancellations()).toBe(2);
  });
});

function admissionPorts(
  overrides: {
    current?: () => Promise<boolean>;
    queue?: () => Promise<unknown>;
    complete?: MessageAdmissionPorts["deliveries"]["completeSubmission"];
    nowMs?: () => number;
  } = {},
): MessageAdmissionPorts {
  return {
    ownership: {
      acquire: async () => fencingToken,
      isCurrent: overrides.current ?? (async () => true),
    },
    nativeQueue: {
      queueMessage: (overrides.queue ?? (async () => ({ kind: "unknown" }))) as never,
    },
    deliveries: {
      completeSubmission:
        overrides.complete ??
        (async (input: { state: DeliveryState }) => ({
          ok: true as const,
          delivery: delivery(input.state),
        })),
    } as never,
    clock: { nowMs: overrides.nowMs ?? (() => 3) },
  };
}

function admit(
  ports: MessageAdmissionPorts,
  options: { abort?: AbortSignal; deadlineMs?: number; recovery?: true } = {},
) {
  return admitClaimedMessage(ports, {
    workspaceKey,
    fencingToken,
    delivery: delivery("submitting"),
    envelope: "{}",
    abort: options.abort ?? new AbortController().signal,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.recovery === true ? { interruptionMeansOwnershipLoss: true as const } : {}),
  });
}

describe("claimed admission finite I/O boundaries", () => {
  test("deadline-aborts native transport and records one nonretryable unknown result", async () => {
    let calls = 0;
    let transportAborted = false;
    const completed: string[] = [];
    const transportStarted = deferred<void>();
    const ports = admissionPorts({
      queue: ((input: { abort: AbortSignal }) => {
        calls += 1;
        transportStarted.resolve();
        input.abort.addEventListener("abort", () => {
          transportAborted = true;
        });
        return never();
      }) as never,
      complete: async (input: { state: string }) => {
        completed.push(input.state);
        return { ok: true as const, delivery: delivery("admission_unknown") };
      },
    });
    const result = await expireAtControlledDeadline(transportStarted.promise, (deadlineMs) =>
      admit(ports, { deadlineMs }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "admission_unknown",
        retryable: false,
        details: { delivery_id: deliveryId },
      },
    });
    expect(transportAborted).toBeTrue();
    expect(calls).toBe(1);
    expect(completed).toContain("admission_unknown");
  });

  test.each(["before", "after"] as const)(
    "records admission_unknown when %s-effect ownership does not settle",
    async (position) => {
      let reads = 0;
      const completed: string[] = [];
      const ownershipStarted = deferred<void>();
      const ports = admissionPorts({
        current: async () => {
          reads += 1;
          if ((position === "before" && reads === 1) || (position === "after" && reads === 2)) {
            ownershipStarted.resolve();
            return never();
          }
          return true;
        },
        complete: async (input: { state: string }) => {
          completed.push(input.state);
          return { ok: true as const, delivery: delivery("admission_unknown") };
        },
      });
      const result = await expireAtControlledDeadline(ownershipStarted.promise, (deadlineMs) =>
        admit(ports, { deadlineMs }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
      });
      expect(completed).toContain("admission_unknown");
    },
  );

  test("normalizes a rejected native call to an unknown outcome", async () => {
    const result = await admit(
      admissionPorts({
        queue: async () => {
          throw new Error("queue unavailable");
        },
      }),
      { deadlineMs: Date.now() + 60_000 },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
  });

  test("normalizes a non-record native result without reflecting through it", async () => {
    const result = await admit(admissionPorts({ queue: async () => null }), {
      deadlineMs: Date.now() + 60_000,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
  });

  test("contains a synchronous recovery transport throw", async () => {
    const result = await admit(
      admissionPorts({
        queue: (() => {
          throw new Error("synchronous transport failure");
        }) as never,
      }),
      { recovery: true },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
  });

  test.each(["nonsettling", "rejected"] as const)(
    "bounds %s outcome recording after the native effect",
    async (mode) => {
      const completionStarted = deferred<void>();
      const ports = admissionPorts({
        complete:
          mode === "nonsettling"
            ? () => {
                completionStarted.resolve();
                return never();
              }
            : () => {
                throw new Error("hostile completion invocation");
              },
      });
      const result =
        mode === "nonsettling"
          ? await expireAtControlledDeadline(completionStarted.promise, (deadlineMs) =>
              admit(ports, { deadlineMs }),
            )
          : await admit(ports, { deadlineMs: Date.now() + 60_000 });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
      });
    },
  );

  test("contains a rejected outcome-recording promise", async () => {
    const hostileOutcome = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") return undefined;
          throw new Error("outcome reflection failed");
        },
      },
    );
    const result = await admit(admissionPorts({ queue: async () => hostileOutcome }), {
      deadlineMs: Date.now() + 60_000,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
  });

  test("maps an ownership fault while recording the outcome", async () => {
    const result = await admit(
      admissionPorts({
        complete: async () => {
          throw new OwnershipLostFault("completion fenced");
        },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
    });
  });

  test("normalizes admitted evidence with an invalid observation time", async () => {
    const result = await admit(
      admissionPorts({
        queue: async () => ({ kind: "admitted", admittedSeq: 1, observedAtMs: -1 }),
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
  });

  test.each(["before-native", "after-native"] as const)(
    "recovery stops when control expires %s",
    async (point) => {
      let clockReads = 0;
      const ports = admissionPorts({
        nowMs: () => {
          clockReads += 1;
          return clockReads >= (point === "before-native" ? 2 : 3) ? 10 : 0;
        },
      });
      const result = await admit(ports, { deadlineMs: 10, recovery: true });
      expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    },
  );
});
