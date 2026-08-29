import { describe, expect, test } from "bun:test";
import type { ParticipantDeletionCandidatesResult } from "../../../src/application/participant-deletion-ports";
import { ParticipantOperationGate } from "../../../src/application/participant-operation-gate";
import {
  isOpenCode118ParticipantActivityEvent,
  parseOpenCode118ParticipantActivityEvent,
} from "../../../src/application/participant-stop-evidence";
import {
  ParticipantStopLifecycle,
  participantStopAntiEntropyIntervalMs,
} from "../../../src/application/participant-stop-lifecycle";
import type { ParticipantStopActivity } from "../../../src/application/participant-stop-ports";
import type { StopPendingRequestsResult } from "../../../src/application/session-stop-ports";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { SessionId } from "../../../src/domain/sessions";
import { validateSessionId } from "../../../src/domain/sessions";
import type { WorkspaceKey } from "../../../src/domain/workspaces";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { deferred } from "../../support/blocking-request-fixture";

function valid<Value>(
  value: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!value.ok) throw new Error("invalid fixture");
  return value.value;
}

const token = valid(validateFencingToken(7));
const workspaceKey = valid(validateWorkspaceKey("workspace:participant-stop"));
const participant = valid(validateSessionId("ses_participant"));

function idleEvent() {
  return { type: "session.idle", properties: { sessionID: participant } };
}

function statusEvent(activity: "busy" | "idle" | "retry") {
  return {
    type: "session.status",
    properties: {
      sessionID: participant,
      status:
        activity === "retry"
          ? { type: "retry", attempt: 1, message: "retrying", next: 10 }
          : { type: activity },
    },
  };
}

function fixture(timerOverrides?: {
  set(delayMs: number, wake: () => void): unknown;
  clear(handle: unknown): void;
}) {
  const calls: string[] = [];
  let activity: ParticipantStopActivity = "idle";
  let callback: (() => void) | undefined;
  let candidates: readonly SessionId[] = [];
  const lifecycle = {
    fencingToken: token,
    status: "ready",
    stop(reason: string) {
      calls.push(`stop:${reason}`);
      this.status = "stopped";
    },
  };
  const requests = {
    async listParticipantDeletionCandidates(): Promise<ParticipantDeletionCandidatesResult> {
      calls.push("list");
      return { ok: true as const, sessionIds: candidates };
    },
    async stopPendingRequests(): Promise<StopPendingRequestsResult> {
      calls.push("persist");
      return { ok: true as const, terminalized: [] };
    },
  };
  const native = {
    async observeParticipantActivity(
      _workspace: WorkspaceKey,
      _session: SessionId,
      _abort: AbortSignal,
    ): Promise<ParticipantStopActivity> {
      calls.push("observe");
      return activity;
    },
  };
  const operations = new ParticipantOperationGate();
  const handler = new ParticipantStopLifecycle({
    requests: requests as never,
    activity: native,
    operations,
    notifications: { notifyTerminal: () => undefined },
    lifecycle: lifecycle as never,
    workspaceKey,
    timers: timerOverrides ?? {
      set(delayMs, wake) {
        expect(delayMs).toBe(participantStopAntiEntropyIntervalMs);
        callback = wake;
        return 1;
      },
      clear(handle) {
        expect(handle).toBe(1);
        calls.push("clear");
      },
    },
  });
  return {
    calls,
    lifecycle,
    requests,
    native,
    operations,
    handler,
    setActivity(value: ParticipantStopActivity) {
      activity = value;
    },
    setCandidates(value: readonly SessionId[]) {
      candidates = value;
    },
    runPeriodic() {
      callback?.();
    },
  };
}

describe("OpenCode participant activity evidence", () => {
  test("parses only exact pinned idle and status shapes", () => {
    expect(parseOpenCode118ParticipantActivityEvent(idleEvent())).toEqual({
      sessionId: participant,
      activity: "idle",
    });
    for (const activity of ["busy", "idle", "retry"] as const) {
      expect(parseOpenCode118ParticipantActivityEvent(statusEvent(activity))).toEqual({
        sessionId: participant,
        activity,
      });
    }
    expect(parseOpenCode118ParticipantActivityEvent({ type: "message.updated" })).toBeUndefined();
    expect(isOpenCode118ParticipantActivityEvent(idleEvent())).toBe(true);
    expect(isOpenCode118ParticipantActivityEvent(null)).toBe(false);
  });

  test("rejects hostile or malformed relevant events without invoking accessors", () => {
    for (const value of [
      { ...idleEvent(), extra: true },
      { type: "session.idle", properties: { sessionID: "bad" } },
      { type: "session.status", properties: { sessionID: participant, status: { type: "other" } } },
      {
        type: "session.status",
        properties: {
          sessionID: participant,
          status: { type: "retry", attempt: -1, message: "x", next: 1 },
        },
      },
    ]) {
      expect(() => parseOpenCode118ParticipantActivityEvent(value)).toThrow("malformed");
    }
    expect(
      parseOpenCode118ParticipantActivityEvent(
        Object.create({ type: "session.idle", properties: { sessionID: participant } }),
      ),
    ).toBeUndefined();
    let accessed = false;
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get() {
        accessed = true;
        return "session.idle";
      },
    });
    Object.defineProperty(accessor, "properties", {
      enumerable: true,
      value: { sessionID: participant },
    });
    expect(isOpenCode118ParticipantActivityEvent(accessor)).toBe(false);
    expect(accessed).toBe(false);

    const hostile = new Proxy(idleEvent(), {
      ownKeys() {
        throw new Error("hostile reflection");
      },
    });
    expect(() => parseOpenCode118ParticipantActivityEvent(hostile)).toThrow("malformed");
  });
});

test("revalidates idle hints and ignores stale, invisible, unknown, and failed observations", async () => {
  for (const activity of ["busy", "retry", "not_visible", "unknown"] as const) {
    const value = fixture();
    value.setActivity(activity);
    await value.handler.handle(idleEvent());
    expect(value.calls).toEqual(["observe"]);
    await value.handler.dispose();
  }
  const rejected = fixture();
  rejected.native.observeParticipantActivity = async () => {
    throw new Error("native unavailable");
  };
  await rejected.handler.handle(idleEvent());
  expect(rejected.calls).toEqual([]);
  await rejected.handler.dispose();
});

test("coalesces duplicate idle work and allows a later busy-to-idle cycle", async () => {
  const value = fixture();
  const observed = deferred<void>();
  const release = deferred<ParticipantStopActivity>();
  value.native.observeParticipantActivity = async () => {
    value.calls.push("observe");
    observed.resolve();
    return release.promise;
  };
  const first = value.handler.handle(idleEvent());
  await observed.promise;
  const duplicate = value.handler.handle(statusEvent("idle"));
  release.resolve("idle");
  await Promise.all([first, duplicate]);
  expect(value.calls).toEqual(["observe", "persist"]);
  await value.handler.handle(idleEvent());
  expect(value.calls).toEqual(["observe", "persist"]);
  await value.handler.handle(statusEvent("busy"));
  value.native.observeParticipantActivity = async () => "idle";
  await value.handler.handle(idleEvent());
  expect(value.calls).toEqual(["observe", "persist", "persist"]);
  await value.handler.dispose();
});

test("fails closed on malformed evidence and invalid persistence output", async () => {
  const malformed = fixture();
  await expect(malformed.handler.handle({ ...idleEvent(), extra: true })).rejects.toThrow(
    "malformed",
  );
  expect(malformed.calls).toEqual(["clear", "stop:shutdown"]);

  for (const [code, stop] of [
    ["ownership_lost", "stop:ownership_lost"],
    ["storage_unavailable", "stop:shutdown"],
  ] as const) {
    const persistence = fixture();
    persistence.requests.stopPendingRequests = async () => ({ ok: false, code });
    await expect(persistence.handler.handle(idleEvent())).rejects.toThrow("failed closed");
    expect(persistence.calls).toEqual(["observe", "clear", stop]);
  }
});

test("periodically reconciles bounded pending participant candidates", async () => {
  const value = fixture();
  value.setCandidates([participant]);
  value.runPeriodic();
  for (let index = 0; index < 20 && !value.calls.includes("persist"); index += 1)
    await Promise.resolve();
  expect(value.calls).toEqual(["list", "observe", "persist"]);
  await value.handler.dispose();

  const malformed = fixture();
  malformed.setCandidates(["bad" as never]);
  malformed.runPeriodic();
  for (let index = 0; index < 20 && malformed.lifecycle.status === "ready"; index += 1)
    await Promise.resolve();
  expect(malformed.calls).toContain("stop:shutdown");
});

test("fails closed on malformed activity, duplicate candidates, and ownership loss", async () => {
  const activity = fixture();
  activity.setActivity("malformed" as never);
  await expect(activity.handler.handle(idleEvent())).rejects.toThrow("failed closed");
  expect(activity.calls).toContain("stop:shutdown");

  const duplicate = fixture();
  duplicate.setCandidates([participant, participant]);
  duplicate.runPeriodic();
  for (let index = 0; index < 20 && duplicate.lifecycle.status === "ready"; index += 1)
    await Promise.resolve();
  expect(duplicate.calls).toContain("stop:shutdown");

  const ownership = fixture();
  ownership.requests.listParticipantDeletionCandidates = async () => ({
    ok: false,
    code: "ownership_lost",
  });
  ownership.runPeriodic();
  for (let index = 0; index < 20 && ownership.lifecycle.status === "ready"; index += 1)
    await Promise.resolve();
  expect(ownership.calls).toContain("stop:ownership_lost");
});

test("fails closed when periodic persistence rejects or returns an unavailable result", async () => {
  for (const listParticipantDeletionCandidates of [
    async () => {
      throw new Error("storage unavailable");
    },
    async () => ({ ok: false as const, code: "storage_unavailable" as const }),
  ]) {
    const value = fixture();
    value.requests.listParticipantDeletionCandidates = listParticipantDeletionCandidates;
    value.runPeriodic();
    for (let index = 0; index < 20 && value.lifecycle.status === "ready"; index += 1)
      await Promise.resolve();
    expect(value.calls).toContain("stop:shutdown");
  }
});

test("maps unexpected persistence exceptions to storage failure", async () => {
  const value = fixture();
  value.operations.run = async () => {
    throw new Error("gate operation failed");
  };
  await expect(value.handler.handle(idleEvent())).rejects.toThrow("failed closed");
  expect(value.calls).toEqual(["clear", "stop:shutdown"]);
});

test("bounds concurrent event work and remembered idle sessions", async () => {
  const concurrent = fixture();
  concurrent.native.observeParticipantActivity = async () => {
    concurrent.calls.push("observe");
    return new Promise(() => undefined);
  };
  const active = Array.from({ length: 64 }, (_, index) =>
    concurrent.handler.handle({
      type: "session.idle",
      properties: { sessionID: `ses_concurrent${index}` },
    }),
  );
  while (concurrent.calls.filter((call) => call === "observe").length < 64) await Promise.resolve();
  await expect(
    concurrent.handler.handle({
      type: "session.idle",
      properties: { sessionID: "ses_concurrentOverflow" },
    }),
  ).rejects.toThrow("concurrency exceeded");
  await concurrent.handler.dispose();
  await Promise.all(active);

  const remembered = fixture();
  for (let index = 0; index < 1_025; index += 1) {
    await remembered.handler.handle({
      type: "session.idle",
      properties: { sessionID: `ses_remembered${index}` },
    });
  }
  await remembered.handler.handle({
    type: "session.idle",
    properties: { sessionID: "ses_remembered0" },
  });
  expect(remembered.calls.filter((call) => call === "persist")).toHaveLength(1_026);
  await remembered.handler.dispose();
});

test("contains timer setup, timer cleanup, and closed-gate faults", async () => {
  const setupFailure = fixture({
    set() {
      throw new Error("timer unavailable");
    },
    clear() {},
  });
  expect(setupFailure.calls).toEqual(["stop:shutdown"]);

  const cleanupFailure = fixture({
    set(_delay, wake) {
      void wake;
      return 1;
    },
    clear() {
      throw new Error("timer cleanup unavailable");
    },
  });
  await expect(cleanupFailure.handler.handle({ ...idleEvent(), extra: true })).rejects.toThrow(
    "malformed",
  );
  expect(cleanupFailure.calls).toEqual(["stop:shutdown"]);

  const closed = fixture();
  closed.operations.close();
  await closed.handler.handle(idleEvent());
  expect(closed.calls).toEqual([]);
  await closed.handler.dispose();
});

test("disposal aborts hostile activity reads and rejects later events", async () => {
  const value = fixture();
  let observed: AbortSignal | undefined;
  value.native.observeParticipantActivity = async (_workspace, _session, abort) => {
    observed = abort;
    return new Promise(() => undefined);
  };
  const handling = value.handler.handle(idleEvent());
  while (!observed) await Promise.resolve();
  await value.handler.dispose();
  await value.handler.dispose();
  await handling;
  expect(observed.aborted).toBe(true);
  expect(value.calls).toEqual(["clear"]);
  await value.handler.handle(idleEvent());
  expect(value.calls).toEqual(["clear"]);
});
