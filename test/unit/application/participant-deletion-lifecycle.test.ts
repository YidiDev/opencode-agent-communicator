import { describe, expect, test } from "bun:test";
import {
  isOpenCode11821SessionDeletedEvent,
  parseOpenCode11821SessionDeletedEvent,
} from "../../../src/application/participant-deletion-evidence";
import { ParticipantDeletionLifecycle } from "../../../src/application/participant-deletion-lifecycle";
import type {
  NativeParticipantPresencePort,
  ParticipantDeletionCandidatesResult,
  ParticipantPresence,
} from "../../../src/application/participant-deletion-ports";
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
  return {
    type: "session.deleted",
    properties: {
      info: {
        id: "ses_deleted",
        projectID: "project",
        directory: "/workspace",
        title: "Deleted",
        version: "1.18.21",
        time: { created: 1, updated: 2 },
        ...overrides,
      },
    },
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
    async listParticipantDeletionCandidates(): Promise<ParticipantDeletionCandidatesResult> {
      return { ok: true as const, sessionIds: [] };
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
  const handler = new ParticipantDeletionLifecycle({
    requests,
    presence,
    notifications: { notifyTerminal: () => undefined },
    lifecycle: lifecycle as never,
    workspaceKey: workspace,
    directory: "/workspace",
    projectId: "project",
    ...(timers ? { timers } : {}),
  });
  return { calls, lifecycle, requests, presence, handler };
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

  test("accepts only exact bound root evidence and ignores unrelated events safely", async () => {
    const value = fixture();
    await value.handler.handle({ type: "message.updated", properties: {} });
    await value.handler.handle(event({ directory: "/other" }));
    await value.handler.handle(event({ projectID: "other" }));
    await value.handler.handle(event({ parentID: "ses_parent" }));
    await value.handler.handle(event());
    await value.handler.handle(event());
    expect(value.calls).toEqual(["persist"]);
    await value.handler.dispose();
    await value.handler.handle(event());
    expect(value.calls).toEqual(["persist"]);
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
});

describe("OpenCode 1.18.21 participant deletion evidence", () => {
  test("parses the complete pinned optional session shape without retaining mutable input", () => {
    const input = event({
      time: { created: 1, updated: 2, compacting: 3 },
      summary: {
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [{ file: "a.ts", before: "a", after: "b", additions: 1, deletions: 1 }],
      },
      share: { url: "https://example.test/session" },
      revert: { messageID: "msg", partID: "part", snapshot: "snapshot", diff: "diff" },
    });
    const parsed = parseOpenCode11821SessionDeletedEvent(input);
    expect(parsed).toEqual({
      sessionId: valid(validateSessionId("ses_deleted")),
      projectId: "project",
      directory: "/workspace",
      isRoot: true,
    });
    expect(Object.isFrozen(parsed)).toBe(true);

    const nullSession = Object.assign(Object.create(null), event().properties.info);
    const nullProperties = Object.assign(Object.create(null), { info: nullSession });
    const nullEvent = Object.assign(Object.create(null), {
      type: "session.deleted",
      properties: nullProperties,
    });
    expect(parseOpenCode11821SessionDeletedEvent(nullEvent)).toMatchObject({
      sessionId: "ses_deleted",
      isRoot: true,
    });
  });

  test("rejects hostile deletion evidence without invoking accessors", () => {
    let reads = 0;
    const accessor = Object.defineProperty(event(), "properties", {
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
      expect(parseOpenCode11821SessionDeletedEvent(value)).toBeUndefined();
    }
    expect(reads).toBe(0);

    for (const properties of [
      Object.create({ info: event().properties.info }),
      Object.defineProperty({}, "info", { enumerable: true, get: () => event().properties.info }),
      Object.defineProperty({ info: event().properties.info }, Symbol("hidden"), { value: true }),
    ]) {
      expect(() =>
        parseOpenCode11821SessionDeletedEvent({ type: "session.deleted", properties }),
      ).toThrow("malformed");
    }

    const typeAccessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "session.deleted";
      },
    });
    expect(isOpenCode11821SessionDeletedEvent(typeAccessor)).toBe(false);
    expect(
      isOpenCode11821SessionDeletedEvent(
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
    expect(isOpenCode11821SessionDeletedEvent(null)).toBe(false);
    expect(isOpenCode11821SessionDeletedEvent([])).toBe(false);
    expect(reads).toBe(0);
  });

  test("fails closed on malformed optional session fields and dense diff violations", () => {
    const sparseDiffs = new Array(1);
    const indexedAccessor: unknown[] = [];
    Object.defineProperty(indexedAccessor, "0", { enumerable: true, get: () => "ignored" });
    Object.defineProperty(indexedAccessor, "length", { value: 1 });
    const inheritedDiffs = Object.setPrototypeOf([], null);
    const malformed: Record<string, unknown>[] = [
      { time: { created: -1, updated: 2 } },
      { time: { created: 1, updated: 2, compacting: -1 } },
      { summary: { additions: -1, deletions: 0, files: 0 } },
      { summary: { additions: 0, deletions: Number.NaN, files: 0 } },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: sparseDiffs } },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: indexedAccessor } },
      { summary: { additions: 0, deletions: 0, files: 0, diffs: inheritedDiffs } },
      {
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
          diffs: [{ file: "a", before: "", after: "", additions: -1, deletions: 0 }],
        },
      },
      {
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
          diffs: [{ file: 1, before: "", after: "", additions: 0, deletions: 0 }],
        },
      },
      {
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
          diffs: [{ file: "a", before: "", after: "", additions: 0, deletions: -1 }],
        },
      },
      { share: { url: 1 } },
      { share: { url: "x".repeat(8_193) } },
      { revert: { messageID: 1 } },
      { revert: { messageID: "msg", partID: 1 } },
      { parentID: "invalid" },
      { projectID: "" },
      { directory: "" },
      { title: "x".repeat(65_537) },
      { version: "x".repeat(257) },
    ];
    for (const override of malformed) {
      expect(() => parseOpenCode11821SessionDeletedEvent(event(override))).toThrow("malformed");
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
            lifecycle: value.lifecycle as never,
            workspaceKey: workspace,
            directory: "/workspace",
            projectId,
          }),
      ).toThrow("binding is malformed");
    }
  });
});
