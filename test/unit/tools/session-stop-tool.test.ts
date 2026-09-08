import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { ParticipantOperationGate } from "../../../src/application/participant-operation-gate";
import type { SessionStopPorts } from "../../../src/application/stop-session";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import {
  sessionStopArgumentsSchema,
  sessionStopFailureCodes,
  ToolContractFault,
} from "../../../src/tools/contracts";
import { invocationStopApproval } from "../../../src/tools/invocation-stop-approval";
import { createSessionStopTool, serializeSessionStopResult } from "../../../src/tools/session-stop";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:tool-stop"));
const fencingToken = valid(validateFencingToken(1));

function ports(): Omit<SessionStopPorts, "approval"> {
  return {
    readiness: { fencingToken, assertReady: () => undefined },
    activity: {
      async observeRequestParticipants() {
        return { sourceVisible: true, targetVisible: true, targetStatus: "idle" };
      },
    },
    requests: { stopPendingRequests: async () => ({ ok: true, terminalized: [] }) },
    nativeInterrupt: { interruptSession: async () => "interrupted" },
    ownership: {
      acquire: async () => fencingToken,
      isCurrent: async () => true,
    },
    notifications: { notifyTerminal: () => undefined },
    participantOperations: new ParticipantOperationGate(),
    digest: {
      async sha256(bytes) {
        return new Uint8Array(createHash("sha256").update(bytes).digest());
      },
    },
  };
}

describe("session_stop tool protocol", () => {
  test("uses strict snake_case arguments and exhaustive declared outcomes", () => {
    expect(sessionStopArgumentsSchema.safeParse({ session_id: "ses_target" }).success).toBe(true);
    expect(
      sessionStopArgumentsSchema.safeParse({ session_id: "ses_target", reason: "done" }).success,
    ).toBe(true);
    for (const value of [
      { sessionId: "ses_target" },
      { session_id: "ses_target", reason: "" },
      { session_id: "ses_target", extra: true },
      { session_id: "bad" },
    ]) {
      expect(sessionStopArgumentsSchema.safeParse(value).success).toBe(false);
    }
    expect(sessionStopFailureCodes).toEqual([
      "invalid_arguments",
      "caller_not_visible",
      "target_not_visible",
      "approval_rejected",
      "deadline_expired",
      "native_unavailable",
      "native_outcome_unknown",
      "ownership_lost",
      "storage_unavailable",
    ]);
  });

  test("asks once per invocation with exact binding and emits snake_case success", async () => {
    const tool = createSessionStopTool(ports(), workspaceKey);
    const approvals: unknown[] = [];
    const context = {
      sessionID: "ses_source",
      messageID: "msg_invocation",
      abort: new AbortController().signal,
      async ask(input: unknown): Promise<void> {
        approvals.push(input);
      },
    };
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const output = JSON.parse(
        await tool.execute({ session_id: "ses_target", reason: "done" }, context),
      ) as Record<string, unknown>;
      expect(output).toMatchObject({
        ok: true,
        value: {
          session_id: "ses_target",
          communicator_state: {
            outcome: "applied",
            requests_terminalized: 0,
            target_stopped: 0,
            source_stopped: 0,
          },
          native_outcome: "already_idle",
        },
      });
    }
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatchObject({
      permission: "session_stop",
      always: [],
      metadata: {
        operation: "session_stop",
        source_session_id: "ses_source",
        target_session_id: "ses_target",
        invocation_message_id: "msg_invocation",
      },
    });
    const serialized = JSON.stringify(approvals[0]);
    expect(serialized).toContain("workspace%3Atool-stop");
    expect(serialized).toMatch(/reason_sha256=[0-9a-f]{64}/);
    expect(serialized).not.toContain('"reason":"done"');
  });

  test("cannot bypass or reuse the invocation approval capability", async () => {
    const noAskAbort = new AbortController().signal;
    const expected = {
      workspaceKey,
      sourceSessionId: "ses_source" as never,
      targetSessionId: "ses_target" as never,
      abort: noAskAbort,
      deadlineMs: 10_000,
    };
    const noAsk = invocationStopApproval(
      {
        sessionID: "ses_source",
        abort: noAskAbort,
      },
      expected,
    );
    await expect(
      noAsk.requestStopApproval(
        {
          workspaceKey,
          sourceSessionId: "ses_source" as never,
          targetSessionId: "ses_target" as never,
          reasonSha256: "a".repeat(64) as never,
        },
        { abort: noAskAbort, deadlineMs: 10_000 },
      ),
    ).rejects.toBeInstanceOf(ToolContractFault);

    const abort = new AbortController().signal;
    const capability = invocationStopApproval(
      {
        sessionID: "ses_source",
        abort,
        ask: async () => undefined,
      },
      { ...expected, abort },
    );
    const binding = {
      workspaceKey,
      sourceSessionId: "ses_source" as never,
      targetSessionId: "ses_target" as never,
      reasonSha256: "b".repeat(64) as never,
    };
    expect(await capability.requestStopApproval(binding, { abort, deadlineMs: 10_000 })).toBe(
      "approved",
    );
    await expect(
      capability.requestStopApproval(binding, { abort, deadlineMs: 10_000 }),
    ).rejects.toBeInstanceOf(ToolContractFault);
  });

  test("rejects mismatched targets, invalid counters, outcomes, and extra result keys", () => {
    const targetSessionId = "ses_target" as never;
    const value = {
      sessionId: targetSessionId,
      communicatorState: {
        outcome: "applied" as const,
        requestsTerminalized: 2,
        targetStopped: 1,
        sourceStopped: 1,
      },
      nativeOutcome: "interrupted" as const,
    };
    expect(
      JSON.parse(serializeSessionStopResult({ ok: true, value }, targetSessionId)),
    ).toMatchObject({
      ok: true,
      value: { session_id: "ses_target", communicator_state: { requests_terminalized: 2 } },
    });
    for (const forged of [
      { ...value, sessionId: "ses_other" },
      { ...value, communicatorState: { ...value.communicatorState, requestsTerminalized: -1 } },
      { ...value, communicatorState: { ...value.communicatorState, targetStopped: 3 } },
      { ...value, communicatorState: { ...value.communicatorState, extra: true } },
      { ...value, nativeOutcome: "unknown" },
      { ...value, extra: true },
    ]) {
      expect(() =>
        serializeSessionStopResult({ ok: true, value: forged } as never, targetSessionId),
      ).toThrow(ToolContractFault);
    }
  });

  test("maps host approval rejection without applying communicator state", async () => {
    let didPersist = false;
    const base = ports();
    const tool = createSessionStopTool(
      {
        ...base,
        requests: {
          async stopPendingRequests() {
            didPersist = true;
            return { ok: true, terminalized: [] };
          },
        },
      },
      workspaceKey,
    );
    const output = JSON.parse(
      await tool.execute(
        { session_id: "ses_target" },
        {
          sessionID: "ses_source",
          abort: new AbortController().signal,
          ask: async () => {
            throw new Error("private rejection");
          },
        },
      ),
    );
    expect(output).toMatchObject({ ok: false, error: { code: "approval_rejected" } });
    expect(JSON.stringify(output)).not.toContain("private rejection");
    expect(didPersist).toBe(false);
  });
});
