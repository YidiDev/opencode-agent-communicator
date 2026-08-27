import { expect, test } from "bun:test";
import type {
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "../../../src/application/request-ports";
import {
  classifyStaleSessionRequests,
  recoverPreparedSessionRequests,
} from "../../../src/application/session-request-recovery-implementation";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function fixtures() {
  const prepared = await requestFixture(token, 1_000);
  const submitting = {
    ...prepared.request,
    deliveryState: "submitting" as const,
    submittedAtMs: 1_001,
    updatedAtMs: 1_001,
  };
  return { prepared, submitting };
}

function inputFor(request: RequestMetadata): SessionRequestRecoveryPhaseInput {
  return {
    workspaceKey: request.workspaceKey,
    fencingToken: token,
    startupBarrier: { established: true, fencingToken: token },
    abort: new AbortController().signal,
    effectSignal: new AbortController().signal,
    deadlineMs: 9_000,
    limit: 10,
  };
}

function portsFor(requests: Record<string, unknown>): SessionRequestRecoveryPorts {
  return {
    requests,
    ownership: { isCurrent: async () => true },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "busy",
      }),
    },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" }) },
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => 1_001 },
  } as unknown as SessionRequestRecoveryPorts;
}

function unknownCompletion(request: RequestMetadata) {
  return {
    ...request,
    deliveryState: "delivery_unknown",
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  };
}

test("stale classification maps ownership checks, write failures, and malformed store results", async () => {
  const { submitting } = await fixtures();
  const cases: Array<readonly [unknown, string]> = [
    [null, "storage_unavailable"],
    [{ ok: false, code: "ownership_lost" }, "ownership_lost"],
    [{ ok: false, code: "future" }, "storage_unavailable"],
    [{ ok: true, request: submitting }, "storage_unavailable"],
  ];
  for (const [completion, code] of cases) {
    let listed = false;
    const ports = portsFor({
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [submitting];
      },
      completeDelivery: async () => completion,
    });
    expect(await classifyStaleSessionRequests(ports, inputFor(submitting))).toMatchObject({
      ok: false,
      error: { code },
    });
  }

  for (const cause of [new OwnershipLostFault("lost"), new Error("disk")]) {
    let listed = false;
    const ports = portsFor({
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [submitting];
      },
      completeDelivery: async () => {
        throw cause;
      },
    });
    expect(await classifyStaleSessionRequests(ports, inputFor(submitting))).toMatchObject({
      ok: false,
      error: {
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      },
    });
  }
});

test("stale classification stops on lifecycle races and ownership port rejection", async () => {
  const { submitting } = await fixtures();
  const aborted = new AbortController();
  aborted.abort("stopped");
  const base = portsFor({ listRecoverableRequests: async () => [] });
  expect(
    await classifyStaleSessionRequests(base, {
      ...inputFor(submitting),
      effectSignal: aborted.signal,
    }),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  for (const current of [false, new OwnershipLostFault("lost"), new Error("disk")]) {
    let listed = false;
    const ports = portsFor({
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [submitting];
      },
      completeDelivery: async () => ({ ok: true, request: unknownCompletion(submitting) }),
    });
    ports.ownership.isCurrent = async () => {
      if (typeof current === "boolean") return current;
      throw current;
    };
    expect(await classifyStaleSessionRequests(ports, inputFor(submitting))).toMatchObject({
      ok: false,
      error: {
        code:
          current === false || current instanceof OwnershipLostFault
            ? "ownership_lost"
            : "storage_unavailable",
      },
    });
  }
});

test("prepared recovery maps list and activity rejection contracts", async () => {
  const { prepared } = await fixtures();
  for (const cause of [new OwnershipLostFault("lost"), new Error("disk")]) {
    const listPorts = portsFor({
      listRecoverableRequests: async () => {
        throw cause;
      },
    });
    expect(
      await recoverPreparedSessionRequests(listPorts, inputFor(prepared.request)),
    ).toMatchObject({
      ok: false,
      error: {
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      },
    });

    let listed = false;
    const activityPorts = portsFor({
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [prepared.request];
      },
    });
    activityPorts.activity.observeRequestParticipants = async () => {
      throw cause;
    };
    expect(
      await recoverPreparedSessionRequests(activityPorts, inputFor(prepared.request)),
    ).toMatchObject({
      ok: false,
      error: {
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "native_unavailable",
      },
    });
  }
});

test("prepared recovery rejects malformed pages and claim results", async () => {
  const { prepared } = await fixtures();
  for (const page of [null, [null], [{ ...prepared.request, workspaceKey: "other" }]]) {
    const ports = portsFor({ listRecoverableRequests: async () => page });
    expect(await recoverPreparedSessionRequests(ports, inputFor(prepared.request))).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  }

  const claims: Array<readonly [unknown, string]> = [
    [null, "storage_unavailable"],
    [{ ok: false, code: "ownership_lost" }, "ownership_lost"],
    [{ ok: false, code: "future" }, "storage_unavailable"],
    [{ ok: true, request: prepared.request, envelopeJson: 42 }, "storage_unavailable"],
  ];
  for (const [claim, code] of claims) {
    let listed = false;
    const ports = portsFor({
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [prepared.request];
      },
      claimPrepared: async () => claim,
    });
    expect(await recoverPreparedSessionRequests(ports, inputFor(prepared.request))).toMatchObject({
      ok: false,
      error: { code },
    });
  }
});

test("prepared recovery treats inactive observations as durable skips without claiming", async () => {
  const { prepared } = await fixtures();
  for (const observation of [
    { sourceVisible: false, targetVisible: true, targetStatus: "busy" },
    { sourceVisible: true, targetVisible: false, targetStatus: "busy" },
    { sourceVisible: true, targetVisible: true, targetStatus: "unknown" },
  ] as const) {
    let listed = false;
    let claims = 0;
    const ports = portsFor({
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [prepared.request];
      },
      claimPrepared: async () => {
        claims += 1;
        return { ok: true, request: prepared.request };
      },
    });
    ports.activity.observeRequestParticipants = async () => observation;
    expect(await recoverPreparedSessionRequests(ports, inputFor(prepared.request))).toMatchObject({
      ok: true,
      value: { skipped: 1 },
    });
    expect(claims).toBe(0);
  }
});

test("both recovery phases reject a mismatched startup fencing barrier", async () => {
  const { prepared, submitting } = await fixtures();
  const mismatched = {
    ...inputFor(prepared.request),
    startupBarrier: { established: true as const, fencingToken: 2 as FencingToken },
  };
  const ports = portsFor({ listRecoverableRequests: async () => [] });
  expect(await recoverPreparedSessionRequests(ports, mismatched)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
  expect(
    await classifyStaleSessionRequests(ports, {
      ...mismatched,
      workspaceKey: submitting.workspaceKey,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
});

test("recovery phase input validation rejects malformed identity, signals, limits, and deadlines", async () => {
  const { prepared } = await fixtures();
  const base = inputFor(prepared.request);
  const ports = portsFor({ listRecoverableRequests: async () => [] });
  for (const mutation of [
    { workspaceKey: "" },
    { fencingToken: 0 },
    { abort: null },
    { effectSignal: null },
    { limit: 101 },
    { deadlineMs: -1 },
  ]) {
    expect(
      await recoverPreparedSessionRequests(ports, { ...base, ...mutation } as never),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  }
});

test("prepared recovery stops before activity and contains synchronous activity throws", async () => {
  const { prepared } = await fixtures();
  const aborted = new AbortController();
  aborted.abort("stopped");
  const stoppedPorts = portsFor({ listRecoverableRequests: async () => [prepared.request] });
  expect(
    await recoverPreparedSessionRequests(stoppedPorts, {
      ...inputFor(prepared.request),
      effectSignal: aborted.signal,
    }),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  let listed = false;
  const throwing = portsFor({
    listRecoverableRequests: async () => {
      if (listed) return [];
      listed = true;
      return [prepared.request];
    },
  });
  throwing.activity.observeRequestParticipants = (() => {
    throw new Error("synchronous native fault");
  }) as never;
  expect(await recoverPreparedSessionRequests(throwing, inputFor(prepared.request))).toMatchObject({
    ok: false,
    error: { code: "native_unavailable" },
  });
});

test("prepared claims must preserve request identity exactly", async () => {
  const { prepared } = await fixtures();
  let listed = false;
  const ports = portsFor({
    listRecoverableRequests: async () => {
      if (listed) return [];
      listed = true;
      return [prepared.request];
    },
    claimPrepared: async () => ({
      ok: true,
      request: { ...prepared.request, targetSessionId: prepared.request.sourceSessionId },
      envelopeJson: prepared.envelopeJson,
    }),
  });
  expect(await recoverPreparedSessionRequests(ports, inputFor(prepared.request))).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
});

test("stale traversal rejects a duplicate page after the first durable classification", async () => {
  const { submitting } = await fixtures();
  const ports = portsFor({
    listRecoverableRequests: async () => [submitting, submitting],
    completeDelivery: async () => ({ ok: true, request: unknownCompletion(submitting) }),
  });
  expect(await classifyStaleSessionRequests(ports, inputFor(submitting))).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
});

test("active prepared claims can skip without an envelope or propagate failed admission", async () => {
  const { prepared, submitting } = await fixtures();
  for (const [claimed, expected] of [
    [
      { ok: true, request: prepared.request },
      { ok: true, value: { skipped: 1 } },
    ],
    [
      { ok: true, request: submitting, envelopeJson: prepared.envelopeJson },
      { ok: false, error: { code: "ownership_lost" } },
    ],
  ] as const) {
    let listed = false;
    const ports = portsFor({
      listRecoverableRequests: async () => {
        if (listed) return [];
        listed = true;
        return [prepared.request];
      },
      claimPrepared: async () => claimed,
    });
    if (claimed.request.deliveryState === "submitting") {
      ports.ownership.isCurrent = async () => false;
    }
    expect(await recoverPreparedSessionRequests(ports, inputFor(prepared.request))).toMatchObject(
      expected,
    );
  }
});

test("recovery accepts retry activity, optional deadlines, and exact state-conflict failures", async () => {
  const { prepared, submitting } = await fixtures();
  let listed = false;
  const retry = portsFor({
    listRecoverableRequests: async () => {
      if (listed) return [];
      listed = true;
      return [prepared.request];
    },
    claimPrepared: async () => ({ ok: true, request: prepared.request }),
  });
  retry.activity.observeRequestParticipants = async () => ({
    sourceVisible: true,
    targetVisible: true,
    targetStatus: "retry",
  });
  const { deadlineMs: _deadlineMs, ...withoutDeadline } = inputFor(prepared.request);
  expect(await recoverPreparedSessionRequests(retry, withoutDeadline)).toMatchObject({
    ok: true,
    value: { skipped: 1 },
  });

  let staleListed = false;
  const conflict = portsFor({
    listRecoverableRequests: async () => {
      if (staleListed) return [];
      staleListed = true;
      return [submitting];
    },
    completeDelivery: async () => ({ ok: false, code: "state_conflict" }),
  });
  expect(await classifyStaleSessionRequests(conflict, inputFor(submitting))).toMatchObject({
    ok: false,
    error: { code: "state_conflict" },
  });
});

test("prepared recovery checks control again before each activity effect", async () => {
  const { prepared } = await fixtures();
  let clockReads = 0;
  let listed = false;
  const ports = portsFor({
    listRecoverableRequests: async () => {
      if (listed) return [];
      listed = true;
      return [prepared.request];
    },
  });
  ports.clock.nowMs = () => {
    clockReads += 1;
    return clockReads === 1 ? 1_001 : 9_000;
  };
  expect(await recoverPreparedSessionRequests(ports, inputFor(prepared.request))).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
});

test("empty prepared traversal propagates failure from its residual proof read", async () => {
  const { prepared } = await fixtures();
  let reads = 0;
  const ports = portsFor({
    listRecoverableRequests: async () => {
      reads += 1;
      if (reads === 1) return [];
      throw new Error("residual unavailable");
    },
  });
  expect(await recoverPreparedSessionRequests(ports, inputFor(prepared.request))).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
  expect(reads).toBe(2);
});

test("stale completion contains an effect-signal contract fault raised after listing", async () => {
  const { submitting } = await fixtures();
  const controller = new AbortController();
  let hostile = false;
  const effectSignal = new Proxy(controller.signal, {
    get(target, key) {
      if (key === "aborted") {
        if (hostile) throw new Error("effect signal contract");
        return target.aborted;
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ports = portsFor({
    listRecoverableRequests: async () => [submitting],
    completeDelivery: async () => ({ ok: true, request: unknownCompletion(submitting) }),
  });
  ports.ownership.isCurrent = async () => {
    queueMicrotask(() => {
      hostile = true;
    });
    return true;
  };
  expect(
    await classifyStaleSessionRequests(ports, { ...inputFor(submitting), effectSignal }),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});
