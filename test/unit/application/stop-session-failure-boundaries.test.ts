import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { type SessionStopPorts, stopSession } from "../../../src/application/stop-session";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:stop-failures"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const token = value(validateFencingToken(4));

function fixture(): SessionStopPorts {
  return {
    readiness: { fencingToken: token, assertReady() {} },
    activity: {
      async observeRequestParticipants() {
        return { sourceVisible: true, targetVisible: true, targetStatus: "busy" };
      },
    },
    approval: { requestStopApproval: async () => "approved" },
    requests: { stopPendingRequests: async () => ({ ok: true, terminalized: [] }) },
    nativeInterrupt: { interruptSession: async () => "interrupted" },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    notifications: { notifyTerminal() {} },
    digest: {
      async sha256(bytes) {
        return new Uint8Array(createHash("sha256").update(bytes).digest());
      },
    },
  };
}

function execute(
  ports: SessionStopPorts,
  abort = new AbortController().signal,
  deadlineMs?: number,
) {
  return stopSession(
    ports,
    { workspaceKey, sourceSessionId, abort, ...(deadlineMs === undefined ? {} : { deadlineMs }) },
    { session_id: targetSessionId, reason: "finished" },
  );
}

describe("session-stop failure and race boundaries", () => {
  test("fails before approval for malformed, hidden, unavailable, and unknown observations", async () => {
    const malformed = fixture();
    malformed.activity.observeRequestParticipants = async () => ({ extra: true }) as never;
    expect(await execute(malformed)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });

    const hidden = fixture();
    hidden.activity.observeRequestParticipants = async () => ({
      sourceVisible: false,
      targetVisible: true,
      targetStatus: "busy",
    });
    expect(await execute(hidden)).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible" },
    });

    for (const cause of [new OwnershipLostFault("lease"), new Error("native")]) {
      const unavailable = fixture();
      unavailable.activity.observeRequestParticipants = async () => {
        throw cause;
      };
      expect(await execute(unavailable)).toMatchObject({
        ok: false,
        error: {
          code: cause instanceof OwnershipLostFault ? "ownership_lost" : "native_unavailable",
        },
      });
    }

    const unknown = fixture();
    unknown.activity.observeRequestParticipants = async () => ({
      sourceVisible: true,
      targetVisible: true,
      targetStatus: "unknown",
    });
    expect(await execute(unknown)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
  });

  test("rejects malformed and explicit persistence failures after approval", async () => {
    for (const raw of [
      undefined,
      { ok: false, code: "ownership_lost" },
      { ok: false, code: "storage_unavailable" },
      { ok: false, code: "future" },
      { ok: true, terminalized: [], extra: true },
      { ok: true, terminalized: "not-an-array" },
    ]) {
      const ports = fixture();
      ports.requests.stopPendingRequests = async () => raw as never;
      const result = await execute(ports);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected persistence failure");
      expect(result.error.code).toBe(
        (raw as { code?: string } | undefined)?.code === "ownership_lost"
          ? "ownership_lost"
          : "storage_unavailable",
      );
    }
  });

  test("maps commit exceptions and post-commit native exceptions conservatively", async () => {
    for (const cause of [new OwnershipLostFault("lease"), new Error("disk")]) {
      const ports = fixture();
      ports.requests.stopPendingRequests = async () => {
        throw cause;
      };
      expect(await execute(ports)).toMatchObject({
        ok: false,
        error: {
          code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        },
      });
    }

    const native = fixture();
    native.nativeInterrupt.interruptSession = async () => {
      throw new Error("transport disappeared");
    };
    expect(await execute(native)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
  });

  test("contains preflight and in-flight abort races without committing", async () => {
    expect(await execute(fixture(), new AbortController().signal, Date.now())).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });

    const controller = new AbortController();
    const ports = fixture();
    ports.activity.observeRequestParticipants = () => {
      controller.abort("caller cancelled");
      return new Promise(() => undefined);
    };
    expect(await execute(ports, controller.signal, Date.now() + 1_000)).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
  });

  test("reports post-commit deadline and abort uncertainty with communicator state", async () => {
    const deadline = fixture();
    let observations = 0;
    deadline.activity.observeRequestParticipants = async () => {
      observations += 1;
      if (observations === 3) return new Promise(() => undefined);
      return { sourceVisible: true, targetVisible: true, targetStatus: "busy" };
    };
    expect(await execute(deadline, new AbortController().signal, Date.now() + 5)).toMatchObject({
      ok: false,
      error: {
        code: "native_outcome_unknown",
        details: {
          communicator_state: {
            outcome: "applied",
            requests_terminalized: 0,
            target_stopped: 0,
            source_stopped: 0,
          },
        },
      },
    });

    const controller = new AbortController();
    const aborted = fixture();
    aborted.nativeInterrupt.interruptSession = () => {
      controller.abort("caller cancelled after commit");
      return new Promise(() => undefined);
    };
    expect(await execute(aborted, controller.signal, Date.now() + 1_000)).toMatchObject({
      ok: false,
      error: {
        code: "native_outcome_unknown",
        details: { communicator_state: { outcome: "applied" } },
      },
    });
  });
});
