import { afterEach, expect, test } from "bun:test";

import {
  createBlockingSessionRequest,
  RequestRuntimeShutdownFault,
  type SessionBlockingRequestPorts,
} from "../../../src/application/create-blocking-session-request";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import { blockingRequestFixture } from "../../support/blocking-request-fixture";
import { cleanupRequestStoreRoots } from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

const args = (target: string) => ({
  session_id: target,
  milestone: "ready",
  timeout_seconds: 30,
});

test("creation rejects malformed invocation deadline, clock, and timer ports", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  expect(
    await createBlockingSessionRequest(
      setup.ports,
      { ...setup.context, deadlineMs: Number.NaN },
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  for (const clock of [
    { nowMs: () => Number.NaN },
    {
      nowMs: () => {
        throw new Error("clock");
      },
    },
  ]) {
    expect(
      await createBlockingSessionRequest(
        { ...setup.ports, clock },
        setup.context,
        "wait",
        args(setup.target),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
  expect(
    await createBlockingSessionRequest(
      {
        ...setup.ports,
        deadlineTimer: {
          arm: () => {
            throw new Error("timer");
          },
        },
      } as SessionBlockingRequestPorts,
      setup.context,
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  setup.store.close();
});

test("creation maps caller membership abort, rejection, malformed data, and invisibility", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const cases: readonly [() => Promise<unknown>, string][] = [
    [async () => ({ sourceVisible: "yes" }), "native_unavailable"],
    [async () => ({ sourceVisible: false }), "caller_not_visible"],
    [async () => Promise.reject(new OwnershipLostFault("lost")), "ownership_lost"],
    [async () => Promise.reject(new Error("native")), "native_unavailable"],
  ];
  for (const [readCurrentRoots, code] of cases) {
    expect(
      await createBlockingSessionRequest(
        {
          ...setup.ports,
          membership: { readCurrentRoots },
        } as unknown as SessionBlockingRequestPorts,
        setup.context,
        "wait",
        args(setup.target),
      ),
    ).toMatchObject({ ok: false, error: { code } });
  }
  const abort = new AbortController();
  abort.abort("caller");
  expect(
    await createBlockingSessionRequest(
      setup.ports,
      { ...setup.context, abort: abort.signal },
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test("creation fails closed for digest, generated ID, authorization, and activity port faults", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const failures: Array<readonly [Partial<SessionBlockingRequestPorts>, string]> = [
    [
      {
        digest: {
          sha256: async () => {
            throw new Error("digest");
          },
        },
      } as never,
      "storage_unavailable",
    ],
    [
      {
        ids: {
          requestId: () => {
            throw new Error("entropy");
          },
        },
      } as never,
      "storage_unavailable",
    ],
    [
      {
        ids: {
          requestId: () => "bad",
          nativeMessageId: () => "bad",
          startOperationId: () => "bad",
        },
      } as never,
      "storage_unavailable",
    ],
    [
      { authorization: { authorizeRequest: async () => ({ kind: "future" }) } } as never,
      "storage_unavailable",
    ],
    [
      {
        authorization: {
          authorizeRequest: async () => {
            throw new Error("approval store");
          },
        },
      } as never,
      "storage_unavailable",
    ],
    [
      { activity: { observeRequestParticipants: async () => ({ malformed: true }) } } as never,
      "native_unavailable",
    ],
    [
      {
        activity: {
          observeRequestParticipants: async () => {
            throw new OwnershipLostFault("lost");
          },
        },
      } as never,
      "ownership_lost",
    ],
    [
      {
        activity: {
          observeRequestParticipants: async () => {
            throw new Error("native");
          },
        },
      } as never,
      "native_unavailable",
    ],
  ];
  for (const [override, code] of failures) {
    expect(
      await createBlockingSessionRequest(
        { ...setup.ports, ...override } as SessionBlockingRequestPorts,
        setup.context,
        "wait",
        args(setup.target),
      ),
    ).toMatchObject({ ok: false, error: { code } });
  }
  setup.store.close();
});

test("creation checkpoints cancellation after membership, authorization, and activity effects", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  for (const phase of ["membership", "authorization", "activity"] as const) {
    const abort = new AbortController();
    const override =
      phase === "membership"
        ? {
            membership: {
              readCurrentRoots: async () => {
                abort.abort("membership_race");
                return { sourceVisible: true, targetVisible: true };
              },
            },
          }
        : phase === "authorization"
          ? {
              authorization: {
                authorizeRequest: async () => {
                  abort.abort("authorization_race");
                  return { kind: "allow" as const };
                },
              },
            }
          : {
              activity: {
                observeRequestParticipants: async () => {
                  abort.abort("activity_race");
                  return {
                    sourceVisible: true,
                    targetVisible: true,
                    targetStatus: "busy" as const,
                  };
                },
              },
            };
    expect(
      await createBlockingSessionRequest(
        { ...setup.ports, ...override } as SessionBlockingRequestPorts,
        { ...setup.context, abort: abort.signal },
        "wait",
        args(setup.target),
      ),
    ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  }
  setup.store.close();
});

test("creation validates digest output, envelope settlement, ownership, and safe deadline arithmetic", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  expect(
    await createBlockingSessionRequest(
      {
        ...setup.ports,
        digest: { sha256: async () => new Uint8Array(1) },
      } as SessionBlockingRequestPorts,
      setup.context,
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  let digests = 0;
  expect(
    await createBlockingSessionRequest(
      {
        ...setup.ports,
        digest: {
          sha256: async (value) => {
            digests += 1;
            if (digests > 1) throw new Error("envelope digest");
            return setup.ports.digest.sha256(value);
          },
        },
      } as SessionBlockingRequestPorts,
      setup.context,
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  expect(
    await createBlockingSessionRequest(
      {
        ...setup.ports,
        ownership: { acquire: () => setup.store.acquire(), isCurrent: async () => false },
      },
      setup.context,
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  const nearMaximum = Number.MAX_SAFE_INTEGER - 1_000;
  expect(
    await createBlockingSessionRequest(
      { ...setup.ports, clock: { nowMs: () => nearMaximum } },
      { ...setup.context, deadlineMs: Number.MAX_SAFE_INTEGER },
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });

  let authorizationCalls = 0;
  let timerCancellations = 0;
  let armedDelay: number | undefined;
  expect(
    await createBlockingSessionRequest(
      {
        ...setup.ports,
        authorization: {
          authorizeRequest: async () => {
            authorizationCalls += 1;
            return { kind: "allow" as const };
          },
        },
        deadlineTimer: {
          arm: (delayMs) => {
            armedDelay = delayMs;
            return {
              cancel: () => {
                timerCancellations += 1;
              },
            };
          },
        },
      },
      { ...setup.context, deadlineMs: 85_000 },
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
  expect(armedDelay).toBe(60_000);
  expect(authorizationCalls).toBe(0);
  expect(timerCancellations).toBe(1);
  setup.store.close();
});

test("an already-expired invocation is rejected even when its zero-delay timer is lazy", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  let armedDelay: number | undefined;
  let membershipReads = 0;
  const result = await createBlockingSessionRequest(
    {
      ...setup.ports,
      membership: {
        readCurrentRoots: async () => {
          membershipReads += 1;
          return { sourceTitle: undefined, sourceVisible: true, targetVisible: true };
        },
      },
      deadlineTimer: {
        arm: (delayMs, _wake) => {
          armedDelay = delayMs;
          return { cancel: () => undefined };
        },
      },
    },
    { ...setup.context, deadlineMs: 25_000 },
    "wait",
    args(setup.target),
  );

  expect(result).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  expect(armedDelay).toBe(0);
  expect(membershipReads).toBe(1);
  setup.store.close();
});

test("creation checks time at each pre-effect boundary and rejects malformed payloads", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  expect(
    await createBlockingSessionRequest(setup.ports, setup.context, "wait", {
      ...args(setup.target),
      extra: true,
    }),
  ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  for (const failAt of [3, 4, 7]) {
    let reads = 0;
    const result = await createBlockingSessionRequest(
      {
        ...setup.ports,
        clock: {
          nowMs: () => {
            reads += 1;
            return reads >= failAt ? setup.context.deadlineMs : 25_000;
          },
        },
      },
      setup.context,
      "wait",
      args(setup.target),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  }
  setup.store.close();
});

test("creation handles envelope cancellation and ownership loss after activity", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const envelopeAbort = new AbortController();
  let digests = 0;
  expect(
    await createBlockingSessionRequest(
      {
        ...setup.ports,
        digest: {
          sha256: async (value) => {
            digests += 1;
            if (digests === 2) envelopeAbort.abort("envelope_cancelled");
            return setup.ports.digest.sha256(value);
          },
        },
      },
      { ...setup.context, abort: envelopeAbort.signal },
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });

  let ownershipChecks = 0;
  expect(
    await createBlockingSessionRequest(
      {
        ...setup.ports,
        ownership: {
          acquire: () => setup.store.acquire(),
          isCurrent: async () => {
            ownershipChecks += 1;
            return ownershipChecks < 3;
          },
        },
      },
      setup.context,
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  setup.store.close();
});

test("creation propagates runtime shutdown committed during preparation", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const requests = Object.create(setup.store) as SessionBlockingRequestPorts["requests"];
  requests.createPrepared = async (input) => {
    const result = await setup.store.createPrepared(input);
    setup.runtime.stop("shutdown");
    return result;
  };
  await expect(
    createBlockingSessionRequest(
      { ...setup.ports, requests },
      setup.context,
      "wait",
      args(setup.target),
    ),
  ).rejects.toBeInstanceOf(RequestRuntimeShutdownFault);
  setup.store.close();
});

test("creation accepts an abort signal whose reason is absent", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const fakeAbort = {
    aborted: true,
    reason: undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as AbortSignal;
  expect(
    await createBlockingSessionRequest(
      setup.ports,
      { ...setup.context, abort: fakeAbort },
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});

test("creation rechecks cancellation after an ownership read races the caller", async () => {
  const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
  const abort = new AbortController();
  expect(
    await createBlockingSessionRequest(
      {
        ...setup.ports,
        ownership: {
          acquire: () => setup.store.acquire(),
          isCurrent: async () => {
            abort.abort("ownership_race");
            return true;
          },
        },
      },
      { ...setup.context, abort: abort.signal },
      "wait",
      args(setup.target),
    ),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  setup.store.close();
});
