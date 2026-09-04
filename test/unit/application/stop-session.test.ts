import { describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";

import { ParticipantOperationGate } from "../../../src/application/participant-operation-gate";
import { type SessionStopPorts, stopSession } from "../../../src/application/stop-session";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { ActivityStatus } from "../../../src/domain/sessions";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:stop"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const fencingToken = valid(validateFencingToken(1));

function fixture(statuses: ActivityStatus[]) {
  const calls: string[] = [];
  let observation = 0;
  let isCurrent = true;
  let approval: "approved" | "rejected" = "approved";
  let interrupt: "interrupted" | "unknown" = "interrupted";
  let visibility = { sourceVisible: true, targetVisible: true };
  const ports: SessionStopPorts = {
    readiness: {
      fencingToken,
      assertReady: () => calls.push("ready"),
      ownershipLost: () => calls.push("lifecycle:ownership_lost"),
    },
    activity: {
      async observeRequestParticipants() {
        calls.push("observe");
        const status = statuses[Math.min(observation, statuses.length - 1)] ?? "unknown";
        observation += 1;
        return { ...visibility, targetStatus: status };
      },
    },
    approval: {
      async requestStopApproval() {
        calls.push("approval");
        return approval;
      },
    },
    requests: {
      async stopPendingRequests() {
        calls.push("commit");
        return { ok: true, terminalized: [] };
      },
    },
    nativeInterrupt: {
      async interruptSession() {
        calls.push("interrupt");
        return interrupt;
      },
    },
    ownership: {
      async acquire() {
        calls.push("acquire");
        return fencingToken;
      },
      async isCurrent() {
        calls.push("ownership");
        return isCurrent;
      },
    },
    notifications: { notifyTerminal: () => undefined },
    participantOperations: new ParticipantOperationGate(),
    digest: {
      async sha256(bytes) {
        return new Uint8Array(createHash("sha256").update(bytes).digest());
      },
    },
  };
  return {
    ports,
    calls,
    rejectApproval: () => {
      approval = "rejected";
    },
    loseOwnership: () => {
      isCurrent = false;
    },
    makeNativeUnknown: () => {
      interrupt = "unknown";
    },
    hideTarget: () => {
      visibility = { sourceVisible: true, targetVisible: false };
    },
  };
}

async function execute(fake: ReturnType<typeof fixture>) {
  return stopSession(
    fake.ports,
    { workspaceKey, sourceSessionId, abort: new AbortController().signal },
    { session_id: targetSessionId, reason: "done" },
  );
}

describe("stop session application workflow", () => {
  test("always asks, terminalizes idle coordination state, and never interrupts idle", async () => {
    const fake = fixture(["idle"]);
    expect(await execute(fake)).toEqual({
      ok: true,
      value: {
        sessionId: targetSessionId,
        communicatorState: {
          outcome: "applied",
          requestsTerminalized: 0,
          targetStopped: 0,
          sourceStopped: 0,
        },
        nativeOutcome: "already_idle",
      },
    });
    expect(fake.calls).toEqual([
      "ready",
      "observe",
      "approval",
      "observe",
      "ownership",
      "commit",
      "observe",
    ]);
  });

  test("rechecks active visibility and ownership immediately before interrupt", async () => {
    const fake = fixture(["busy", "retry"]);
    expect(await execute(fake)).toMatchObject({
      ok: true,
      value: { nativeOutcome: "interrupted" },
    });
    expect(fake.calls).toEqual([
      "ready",
      "observe",
      "approval",
      "observe",
      "ownership",
      "commit",
      "observe",
      "ownership",
      "interrupt",
      "ownership",
    ]);
  });

  test("rejects unauthorized visibility and approval before state mutation", async () => {
    const hidden = fixture(["busy"]);
    hidden.hideTarget();
    expect(await execute(hidden)).toMatchObject({
      ok: false,
      error: { code: "target_not_visible" },
    });
    expect(hidden.calls).toEqual(["ready", "observe"]);
    const rejected = fixture(["busy"]);
    rejected.rejectApproval();
    expect(await execute(rejected)).toMatchObject({
      ok: false,
      error: { code: "approval_rejected" },
    });
    expect(rejected.calls).toEqual(["ready", "observe", "approval"]);
  });

  test("preserves committed state when ownership or native outcome becomes ambiguous", async () => {
    const ownership = fixture(["busy", "busy"]);
    ownership.loseOwnership();
    const ownershipResult = await execute(ownership);
    expect(ownershipResult).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(ownership.calls).not.toContain("commit");
    expect(ownership.calls).not.toContain("interrupt");
    expect(ownership.calls).toContain("lifecycle:ownership_lost");
    expect(ownership.calls).not.toContain("acquire");

    const transport = fixture(["busy", "busy"]);
    transport.makeNativeUnknown();
    expect(await execute(transport)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
    expect(transport.calls.indexOf("commit")).toBeLessThan(transport.calls.indexOf("interrupt"));
  });

  test("treats an active-to-idle race as idle success without interrupt", async () => {
    const fake = fixture(["busy", "idle"]);
    expect(await execute(fake)).toMatchObject({
      ok: true,
      value: { nativeOutcome: "already_idle" },
    });
    expect(fake.calls).not.toContain("interrupt");
  });

  test("rechecks an idle target that becomes active while approval is pending", async () => {
    const fake = fixture(["idle", "busy"]);
    expect(await execute(fake)).toMatchObject({
      ok: true,
      value: { nativeOutcome: "interrupted" },
    });
    expect(fake.calls).toContain("interrupt");
  });

  test("rejects malformed persistence output without notifying or interrupting", async () => {
    const fake = fixture(["busy", "busy"]);
    let notifications = 0;
    fake.ports.notifications.notifyTerminal = () => {
      notifications += 1;
    };
    fake.ports.requests.stopPendingRequests = async () =>
      ({ ok: true, terminalized: [Object.freeze({ id: "req_untrusted" })] }) as never;
    expect(await execute(fake)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    expect(notifications).toBe(0);
    expect(fake.calls).not.toContain("interrupt");
  });

  test("bounds never-settling and stale approvals without authorizing effects", async () => {
    for (const late of [false, true]) {
      const fake = fixture(["busy"]);
      let approvalStarted!: () => void;
      let settleApproval!: (value: "approved") => void;
      const started = new Promise<void>((resolve) => {
        approvalStarted = resolve;
      });
      const approval = new Promise<"approved">((resolve) => {
        settleApproval = resolve;
      });
      fake.ports.approval.requestStopApproval = () => {
        approvalStarted();
        return approval;
      };
      jest.useFakeTimers();
      try {
        jest.setSystemTime(10_000);
        const pending = stopSession(
          fake.ports,
          {
            workspaceKey,
            sourceSessionId,
            abort: new AbortController().signal,
            deadlineMs: 10_005,
          },
          { session_id: targetSessionId },
        );
        await started;
        jest.advanceTimersByTime(5);
        const result = await pending;
        expect(result).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
        if (late) {
          settleApproval("approved");
          await approval;
        }
        expect(fake.calls).not.toContain("acquire");
        expect(fake.calls).not.toContain("commit");
        expect(fake.calls).not.toContain("interrupt");
      } finally {
        jest.useRealTimers();
      }
    }
  });
});
