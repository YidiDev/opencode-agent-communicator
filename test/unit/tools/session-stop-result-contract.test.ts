import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { ParticipantOperationGate } from "../../../src/application/participant-operation-gate";
import type { SessionStopPorts } from "../../../src/application/stop-session";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { ToolContractFault } from "../../../src/tools/contracts";
import { createSessionStopTool, serializeSessionStopResult } from "../../../src/tools/session-stop";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:stop-result"));
const fencingToken = value(validateFencingToken(1));
const targetSessionId = "ses_target" as never;
const communicatorState = {
  outcome: "applied",
  requests_terminalized: 2,
  target_stopped: 1,
  source_stopped: 1,
};

describe("session_stop result contract", () => {
  test("projects only exact communicator state for an unknown native outcome", () => {
    const failure = {
      ok: false as const,
      error: {
        code: "native_outcome_unknown" as const,
        message: "Native interruption is unknown.",
        retryable: false,
        details: { communicator_state: communicatorState },
      },
    };
    expect(JSON.parse(serializeSessionStopResult(failure, targetSessionId))).toEqual(failure);
    for (const details of [
      undefined,
      { communicator_state: { ...communicatorState, extra: true } },
      { communicator_state: { ...communicatorState, requests_terminalized: -1 } },
      { communicator_state: communicatorState, extra: true },
    ]) {
      expect(() =>
        serializeSessionStopResult(
          {
            ...failure,
            error: {
              ...failure.error,
              ...(details === undefined ? { details: undefined } : { details }),
            },
          } as never,
          targetSessionId,
        ),
      ).toThrow(ToolContractFault);
    }
    expect(() =>
      serializeSessionStopResult(
        {
          ok: false,
          error: {
            code: "native_unavailable",
            message: "Native service is unavailable.",
            retryable: true,
            details: { communicator_state: communicatorState },
          },
        },
        targetSessionId,
      ),
    ).toThrow(ToolContractFault);
  });

  test("returns committed communicator state when production native interruption is ambiguous", async () => {
    const ports: Omit<SessionStopPorts, "approval"> = {
      readiness: { fencingToken, assertReady: () => undefined },
      activity: {
        async observeRequestParticipants() {
          return { sourceVisible: true, targetVisible: true, targetStatus: "busy" };
        },
      },
      requests: { stopPendingRequests: async () => ({ ok: true, terminalized: [] }) },
      nativeInterrupt: {
        async interruptSession() {
          throw new Error("private transport fault");
        },
      },
      ownership: { acquire: async () => fencingToken, isCurrent: async () => true },
      notifications: { notifyTerminal: () => undefined },
      participantOperations: new ParticipantOperationGate(),
      digest: {
        async sha256(bytes) {
          return new Uint8Array(createHash("sha256").update(bytes).digest());
        },
      },
    };
    const tool = createSessionStopTool(ports, workspaceKey);
    const output = JSON.parse(
      await tool.execute(
        { session_id: "ses_target" },
        {
          sessionID: "ses_source",
          abort: new AbortController().signal,
          ask: async () => undefined,
        },
      ),
    );
    expect(output).toMatchObject({
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
    expect(JSON.stringify(output)).not.toContain("private transport fault");
  });
});
