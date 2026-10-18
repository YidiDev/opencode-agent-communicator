import { describe, expect, test } from "bun:test";
import {
  isOpenCode2SessionDeletedEvent,
  parseOpenCode2SessionDeletedEvent,
} from "../../../src/application/participant-deletion-evidence";
import { ParticipantDeletionLifecycle } from "../../../src/application/participant-deletion-lifecycle";
import type {
  NativeParticipantPresencePort,
  ParticipantDeletionCandidatesResult,
  ParticipantPresence,
} from "../../../src/application/participant-deletion-ports";
import { ParticipantOperationGate } from "../../../src/application/participant-operation-gate";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(
  value: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!value.ok) throw new Error("invalid fixture");
  return value.value;
}

const token = valid(validateFencingToken(1));
const workspace = valid(validateWorkspaceKey("workspace:deletion"));

function event(overrides: Record<string, unknown> = {}) {
  const sessionID = overrides.id ?? "ses_deleted";
  const location = Object.hasOwn(overrides, "directory")
    ? { location: { directory: overrides.directory } }
    : {};
  return {
    id: "evt_deleted",
    created: 1,
    type: "session.deleted",
    durable: { aggregateID: String(sessionID), seq: 1, version: 2 },
    ...location,
    data: { sessionID },
  };
}

function terminalized(seed: number, deletedRole: "source" | "target" = "target"): RequestMetadata {
  const hex = seed.toString(16).padStart(32, "0");
  const id = valid(validateRequestId(`req_${hex}`));
  const nativeMessageId = valid(validateNativeMessageId(`msg_${hex}`));
  const deleted = valid(validateSessionId("ses_deleted"));
  const other = valid(validateSessionId(`ses_other${seed}`));
  return {
    id,
    workspaceKey: workspace,
    sourceSessionId: deletedRole === "source" ? deleted : other,
    targetSessionId: deletedRole === "target" ? deleted : other,
    nativeMessageId,
    kind: "wait",
    resolutionState: deletedRole === "target" ? "target_deleted" : "source_deleted",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
    deadlineAtMs: 10,
    resolvedAtMs: 2,
  };
}

function fixture(timers?: {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}) {
  const calls: string[] = [];
  const lifecycle = {
    fencingToken: token,
    status: "ready",
    stop: (reason: string) => calls.push(`stop:${reason}`),
  };
  const requests = {
    async listParticipantDeletionCandidates(_input: {
      readonly fencingToken: typeof token;
      readonly workspaceKey: typeof workspace;
    }): Promise<ParticipantDeletionCandidatesResult> {
      return {
        ok: true as const,
        sessionIds: [
          valid(validateSessionId("ses_deleted")),
          valid(validateSessionId("ses_overflow")),
          ...Array.from({ length: 64 }, (_, index) =>
            valid(validateSessionId(`ses_deleted${index}`)),
          ),
          ...Array.from({ length: 1_025 }, (_, index) =>
            valid(validateSessionId(`ses_history${index}`)),
          ),
        ],
      };
    },
    async deleteParticipantRequests() {
      calls.push("persist");
      return { ok: true as const, terminalized: [] };
    },
    async deleteAbsentParticipantRequests() {
      calls.push("persist-set");
      return { ok: true as const, terminalized: [] };
    },
  };
  const presence: NativeParticipantPresencePort = {
    readParticipantPresence: async (): Promise<ParticipantPresence> => "absent",
  };
  const operations = new ParticipantOperationGate();
  const handler = new ParticipantDeletionLifecycle({
    requests,
    presence,
    notifications: { notifyTerminal: () => undefined },
    contexts: {
      settlePendingContextForParticipant: async () => [],
    },
    contextNotifications: { notifyContextSettled: () => undefined },
    operations,
    lifecycle: lifecycle as never,
    workspaceKey: workspace,
    directory: "/workspace",
    projectId: "project",
    ...(timers ? { timers } : {}),
  });
  return { calls, lifecycle, requests, presence, operations, handler };
}

describe("participant deletion application lifecycle", () => {
  test("treats a valid deletion hook only as a hint and deletes only after exact direct absence", async () => {
    for (const observed of ["present", "unknown"] as const) {
      const value = fixture();
      const observations: Array<{ sessionId: string; abort: AbortSignal }> = [];
      value.presence.readParticipantPresence = async (sessionId, abort) => {
        observations.push({ sessionId, abort });
        return observed;
      };
      await value.handler.handle(event());
      expect(observations).toHaveLength(1);
      expect(observations[0]?.sessionId).toBe("ses_deleted");
      expect(observations[0]?.abort.aborted).toBe(false);
      expect(value.calls).toEqual([]);
      value.presence.readParticipantPresence = async () => "absent";
      await value.handler.handle(event());
      expect(value.calls).toEqual(["persist"]);
      await value.handler.dispose();
    }

    const rejected = fixture();
    rejected.presence.readParticipantPresence = async () => {
      throw new Error("native read rejected");
    };
    await rejected.handler.handle(event());
    expect(rejected.calls).toEqual([]);
    rejected.presence.readParticipantPresence = async () => "absent";
    await rejected.handler.handle(event());
    expect(rejected.calls).toEqual(["persist"]);
    await rejected.handler.dispose();

    const malformed = fixture();
    malformed.presence.readParticipantPresence = async () => "malformed" as never;
    await expect(malformed.handler.handle(event())).rejects.toThrow("failed closed");
    expect(malformed.calls).toEqual(["stop:shutdown"]);
    await malformed.handler.dispose();

    const absent = fixture();
    await absent.handler.handle(event());
    expect(absent.calls).toEqual(["persist"]);
    await absent.handler.dispose();
  });

  test("does not persist when disposal aborts an in-flight hook presence observation", async () => {
    const value = fixture();
    let observedSignal: AbortSignal | undefined;
    value.presence.readParticipantPresence = (_sessionId, abort) => {
      observedSignal = abort;
      return new Promise(() => undefined);
    };
    const handling = value.handler.handle(event());
    while (!observedSignal) await Promise.resolve();
    await value.handler.dispose();
    await handling;
    expect(observedSignal.aborted).toBe(true);
    expect(value.calls).toEqual([]);
  });

  test("authorizes exact evidence with trusted location and scoped participant registry", async () => {
    const value = fixture();
    const lookups: unknown[] = [];
    const list = value.requests.listParticipantDeletionCandidates;
    value.requests.listParticipantDeletionCandidates = async (input) => {
      lookups.push(input);
      return list(input);
    };
    await value.handler.handle({ type: "message.updated", data: {} });
    await value.handler.handle(event({ directory: "/other" }));
    await value.handler.handle(event({ id: "ses_unregistered" }));
    await value.handler.handle(event({ directory: "/workspace" }));
    await value.handler.handle(event());
    expect(value.calls).toEqual(["persist"]);
    expect(lookups).toEqual([
      { fencingToken: token, workspaceKey: workspace },
      { fencingToken: token, workspaceKey: workspace },
      { fencingToken: token, workspaceKey: workspace },
    ]);
    await value.handler.dispose();
    await value.handler.handle(event());
    expect(value.calls).toEqual(["persist"]);
  });

  test("fails closed on registry lookup failures and recognized negative outcomes", async () => {
    const rejected = fixture();
    rejected.requests.listParticipantDeletionCandidates = async () => {
      throw new Error("registry unavailable");
    };
    await expect(rejected.handler.handle(event())).rejects.toThrow("registry lookup failed closed");
    expect(rejected.calls).toEqual(["stop:shutdown"]);

    for (const [result, stopped] of [
      [{ ok: false, code: "ownership_lost" }, "stop:ownership_lost"],
      [{ ok: false, code: "storage_unavailable" }, "stop:shutdown"],
    ] as const) {
      const value = fixture();
      value.requests.listParticipantDeletionCandidates = async () => result;
      await expect(value.handler.handle(event())).rejects.toThrow("registry lookup failed closed");
      expect(value.calls).toEqual([stopped]);
      await value.handler.dispose();
    }
  });

  test("rejects malformed registry records, candidate arrays, IDs, and duplicates", async () => {
    const malformed: unknown[] = [
      null,
      { ok: true, sessionIds: [], extra: true },
      { ok: false, code: "future" },
      { ok: true, sessionIds: "ses_deleted" },
      { ok: true, sessionIds: ["invalid"] },
      { ok: true, sessionIds: ["ses_deleted", "ses_deleted"] },
    ];
    for (const result of malformed) {
      const value = fixture();
      value.requests.listParticipantDeletionCandidates = async () => result as never;
      await expect(value.handler.handle(event())).rejects.toThrow("registry lookup failed closed");
      expect(value.calls).toEqual(["stop:shutdown"]);
      await value.handler.dispose();
    }
  });

  test("fails lifecycle readiness on malformed relevant evidence and persistence failure", async () => {
    const malformed = fixture();
    await expect(malformed.handler.handle({ ...event(), extra: true })).rejects.toThrow(
      "malformed",
    );
    expect(malformed.calls).toEqual(["stop:shutdown"]);

    const failed = fixture();
    failed.requests.deleteParticipantRequests = async () => {
      failed.calls.push("persist");
      return { ok: false, code: "ownership_lost" } as never;
    };
    await expect(failed.handler.handle(event())).rejects.toThrow("failed closed");
    expect(failed.calls).toEqual(["persist", "stop:ownership_lost"]);
  });

  test("aborts admission and drains an already-active persistence operation on disposal", async () => {
    const value = fixture();
    let release!: () => void;
    value.requests.deleteParticipantRequests = async () => {
      value.calls.push("persist");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      value.calls.push("committed");
      return { ok: true, terminalized: [] };
    };
    const handling = value.handler.handle(event());
    while (!release) await Promise.resolve();
    let disposed = false;
    const disposal = value.handler.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await Promise.all([handling, disposal]);
    expect(value.calls).toEqual(["persist", "committed"]);
  });

  test("does not misclassify an in-flight failure after disposal aborts the hint", async () => {
    const value = fixture();
    let reject!: (cause: unknown) => void;
    value.requests.deleteParticipantRequests = () =>
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      });
    const handling = value.handler.handle(event());
    while (!reject) await Promise.resolve();
    const disposal = value.handler.dispose();
    reject(new Error("late persistence failure"));
    await Promise.all([handling, disposal]);
    expect(value.calls).toEqual([]);
  });

  test("fails closed when the participant operation boundary rejects unexpectedly", async () => {
    const value = fixture();
    value.operations.run = async () => {
      throw new Error("operation gate unavailable");
    };
    await expect(value.handler.handle(event())).rejects.toThrow("failed closed");
    expect(value.calls).toEqual(["stop:shutdown"]);
    await value.handler.dispose();
  });
});

describe("participant deletion periodic reconciliation lifecycle", () => {
  test("owns bounded periodic anti-entropy that closes the startup-to-hook deletion race", async () => {
    let callback: (() => void) | undefined;
    let cleared = 0;
    const value = fixture({
      set(delayMs, wake) {
        expect(delayMs).toBe(30_000);
        callback = wake;
        return 1;
      },
      clear(handle) {
        expect(handle).toBe(1);
        cleared += 1;
      },
    });
    value.requests.listParticipantDeletionCandidates = async () => ({
      ok: true,
      sessionIds: [valid(validateSessionId("ses_racedDeletion"))],
    });
    value.presence.readParticipantPresence = async () => "absent";
    callback?.();
    for (let index = 0; index < 20 && value.calls.length === 0; index += 1) await Promise.resolve();
    expect(value.calls).toEqual(["persist-set"]);
    await value.handler.dispose();
    expect(cleared).toBe(0);
  });

  test("disposal interrupts a hostile periodic presence read that ignores its signal", async () => {
    let callback: (() => void) | undefined;
    const value = fixture({
      set(_delay, wake) {
        callback = wake;
        return 1;
      },
      clear() {},
    });
    value.requests.listParticipantDeletionCandidates = async () => ({
      ok: true,
      sessionIds: [valid(validateSessionId("ses_hostilePresence"))],
    });
    let started = false;
    value.presence.readParticipantPresence = () => {
      started = true;
      return new Promise<ParticipantPresence>(() => undefined);
    };
    callback?.();
    while (!started) await Promise.resolve();
    await value.handler.dispose();
    expect(value.calls).toEqual([]);
  });

  test("suppresses a periodic candidate failure released after disposal", async () => {
    let callback: (() => void) | undefined;
    const value = fixture({
      set(_delay, wake) {
        callback = wake;
        return 1;
      },
      clear() {},
    });
    let reject!: (cause: unknown) => void;
    value.requests.listParticipantDeletionCandidates = () =>
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      });
    callback?.();
    while (!reject) await Promise.resolve();
    const disposal = value.handler.dispose();
    reject(new Error("late candidate failure"));
    await disposal;
    expect(value.calls).toEqual([]);
  });

  test("fails closed on invalid periodic timers and skips a tick while not ready", async () => {
    const invalid = fixture({
      set() {
        throw new Error("timer");
      },
      clear() {},
    });
    expect(invalid.calls).toEqual(["stop:shutdown"]);
    await invalid.handler.dispose();

    let callback: (() => void) | undefined;
    const starting = fixture({
      set(_delay, wake) {
        callback = wake;
        return 1;
      },
      clear() {},
    });
    starting.lifecycle.status = "starting";
    callback?.();
    await Promise.resolve();
    expect(starting.calls).toEqual([]);
    await starting.handler.dispose();
  });

  test("maps periodic registry contract and ownership faults while the lifecycle is active", async () => {
    for (const [result, stopped] of [
      [{ ok: true, sessionIds: ["invalid"] }, "stop:shutdown"],
      [{ ok: false, code: "ownership_lost" }, "stop:ownership_lost"],
    ] as const) {
      let callback: (() => void) | undefined;
      const value = fixture({
        set(_delay, wake) {
          callback = wake;
          return 1;
        },
        clear() {},
      });
      value.requests.listParticipantDeletionCandidates = async () => result as never;
      callback?.();
      for (let index = 0; index < 20 && value.calls.length === 0; index += 1)
        await Promise.resolve();
      expect(value.calls).toEqual([stopped]);
      await value.handler.dispose();
    }
  });
});

describe("OpenCode 2.0.26 participant deletion evidence", () => {
  test("parses the exact durable public shape without inferring unavailable session fields", () => {
    const input = {
      ...event(),
      location: { directory: "/workspace", workspaceID: "wrk_1" },
      metadata: { source: "test" },
    };
    const parsed = parseOpenCode2SessionDeletedEvent(input);
    expect(parsed).toEqual({
      sessionId: valid(validateSessionId("ses_deleted")),
      directory: "/workspace",
    });
    expect(Object.isFrozen(parsed)).toBe(true);

    const nullEvent = Object.assign(Object.create(null), event());
    nullEvent.data = Object.assign(Object.create(null), event().data);
    nullEvent.durable = Object.assign(Object.create(null), event().durable);
    expect(parseOpenCode2SessionDeletedEvent(nullEvent)).toEqual({
      sessionId: valid(validateSessionId("ses_deleted")),
    });
  });

  test("rejects hostile deletion evidence without invoking accessors", () => {
    let reads = 0;
    const accessor = Object.defineProperty(event(), "data", {
      enumerable: true,
      get: () => {
        reads += 1;
        return {};
      },
    });
    const symbol = Object.defineProperty(event(), Symbol("hidden"), {
      enumerable: true,
      value: true,
    });
    const inherited = Object.create({ type: "session.deleted" });
    Object.assign(inherited, event());
    const throwing = new Proxy(event(), {
      ownKeys: () => {
        throw new Error("trap");
      },
    });
    for (const value of [accessor, symbol, inherited, throwing]) {
      expect(() => parseOpenCode2SessionDeletedEvent(value)).toThrow("malformed");
    }
    expect(reads).toBe(0);

    const typeAccessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "session.deleted";
      },
    });
    expect(isOpenCode2SessionDeletedEvent(typeAccessor)).toBe(false);
    expect(
      isOpenCode2SessionDeletedEvent(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error("trap");
            },
          },
        ),
      ),
    ).toBe(false);
    expect(isOpenCode2SessionDeletedEvent(null)).toBe(false);
    expect(isOpenCode2SessionDeletedEvent([])).toBe(false);
    expect(reads).toBe(0);
  });

  test("fails closed on malformed v2 envelopes, durable metadata, locations, and data", () => {
    const malformed = [
      { ...event(), id: "" },
      { ...event(), created: Number.NaN },
      { ...event(), durable: { aggregateID: "ses_deleted", seq: -1, version: 2 } },
      { ...event(), durable: { aggregateID: "ses_other", seq: 1, version: 2 } },
      { ...event(), durable: { aggregateID: "ses_deleted", seq: 1, version: 1 } },
      { ...event(), durable: { aggregateID: "ses_deleted", seq: 1 } },
      { ...event(), data: { sessionID: "invalid" } },
      { ...event(), data: { sessionID: "ses_deleted", projectID: "project" } },
      { ...event(), location: { directory: "" } },
      { ...event(), location: { directory: "/workspace", extra: true } },
      { ...event(), properties: { info: {} } },
    ];
    for (const value of malformed) {
      expect(() => parseOpenCode2SessionDeletedEvent(value)).toThrow("malformed");
    }
  });
});

describe("participant deletion fault, concurrency, and deduplication boundaries", () => {
  test("deduplicates concurrent native events and publishes both participant roles once", async () => {
    const value = fixture();
    let release!: () => void;
    let calls = 0;
    value.requests.deleteParticipantRequests = async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, terminalized: [terminalized(1), terminalized(2, "source")] } as never;
    };
    const first = value.handler.handle(event());
    const duplicate = value.handler.handle(event());
    while (!release) await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, duplicate]);
    await value.handler.handle(event());
    expect(calls).toBe(1);
  });

  test("coalesces duplicate session IDs before consuming unique concurrency slots", async () => {
    const value = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    value.requests.deleteParticipantRequests = async () => {
      calls += 1;
      await blocked;
      return { ok: true, terminalized: [] };
    };
    const duplicates = Array.from({ length: 128 }, () => value.handler.handle(event()));
    while (calls === 0) await Promise.resolve();
    expect(calls).toBe(1);
    expect(value.calls).toEqual([]);
    release();
    await Promise.all(duplicates);
  });

  test("classifies thrown and corrupt persistence outcomes and validates committed ownership", async () => {
    const accessorResult = Object.defineProperty({ ok: true }, "terminalized", {
      enumerable: true,
      get: () => [],
    });
    const symbolResult = Object.defineProperty({ ok: true, terminalized: [] }, Symbol("hidden"), {
      value: true,
    });
    const symbolArray = Object.defineProperty([], Symbol("hidden"), { value: true });
    const corrupt = [
      null,
      Object.assign(Object.create({}), { ok: true, terminalized: [] }),
      accessorResult,
      symbolResult,
      { ok: true, terminalized: "not-an-array" },
      { ok: true, terminalized: symbolArray },
      { ok: true, terminalized: [terminalized(1), terminalized(1)] },
      { ok: true, terminalized: [{ ...terminalized(1), workspaceKey: "other" }] },
      { ok: true, terminalized: [{ ...terminalized(1), targetSessionId: "ses_someone" }] },
      { ok: true, terminalized: [{ ...terminalized(1), resolutionState: "source_deleted" }] },
      { ok: false, code: "storage_unavailable" },
      { ok: false, code: "future" },
    ];
    for (const returned of corrupt) {
      const value = fixture();
      value.requests.deleteParticipantRequests = async () => returned as never;
      await expect(value.handler.handle(event())).rejects.toThrow("failed closed");
      expect(value.calls).toEqual(["stop:shutdown"]);
    }

    const rejected = fixture();
    rejected.requests.deleteParticipantRequests = async () => {
      throw new Error("disk unavailable");
    };
    await expect(rejected.handler.handle(event())).rejects.toThrow("disk unavailable");
    expect(rejected.calls).toEqual(["stop:shutdown"]);
  });

  test("bounds completed-session deduplication while keeping recent deletions idempotent", async () => {
    const value = fixture();
    let persistenceCalls = 0;
    value.requests.deleteParticipantRequests = async () => {
      persistenceCalls += 1;
      return { ok: true, terminalized: [] };
    };
    for (let index = 0; index < 1_025; index += 1) {
      await value.handler.handle(event({ id: `ses_history${index}` }));
    }
    await value.handler.handle(event({ id: "ses_history1024" }));
    expect(persistenceCalls).toBe(1_025);
    await value.handler.handle(event({ id: "ses_history0" }));
    expect(persistenceCalls).toBe(1_026);
  });

  test("ignores events unless ready and enforces the bounded active-event budget", async () => {
    const notReady = fixture();
    notReady.lifecycle.status = "recovering";
    await notReady.handler.handle(event());
    expect(notReady.calls).toEqual([]);

    const value = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.requests.deleteParticipantRequests = async () => {
      await blocked;
      return { ok: true, terminalized: [] };
    };
    const active = Array.from({ length: 64 }, (_, index) =>
      value.handler.handle(event({ id: `ses_deleted${index}` })),
    );
    await expect(value.handler.handle(event({ id: "ses_overflow" }))).rejects.toThrow(
      "concurrency exceeded",
    );
    expect(value.calls).toEqual(["stop:shutdown"]);
    release();
    await Promise.all(active);
    await value.handler.dispose();
    await value.handler.dispose();
  });

  test("rejects malformed lifecycle bindings", () => {
    const value = fixture();
    for (const projectId of ["", "x".repeat(513)]) {
      expect(
        () =>
          new ParticipantDeletionLifecycle({
            requests: value.requests,
            presence: { readParticipantPresence: async () => "present" as const },
            notifications: { notifyTerminal: () => undefined },
            operations: new ParticipantOperationGate(),
            lifecycle: value.lifecycle as never,
            workspaceKey: workspace,
            directory: "/workspace",
            projectId,
          }),
      ).toThrow("binding is malformed");
    }
  });
});
