import {
  type SessionStopPorts,
  type SessionStopResult,
  stopSession,
} from "../application/stop-session";
import type { PolicyDecision } from "../domain/authorization-policy";
import type { DomainFailureCode, DomainResult } from "../domain/results";
import { domainFailure } from "../domain/results";
import { pendingRequestsPerWorkspaceHardCeiling } from "../domain/safety-ceilings";
import type { SessionId } from "../domain/sessions";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionStopToolArguments,
  sessionStopArgumentsSchema,
  sessionStopFailureCodes,
  ToolContractFault,
} from "./contracts";
import { invocationStopApproval } from "./invocation-stop-approval";
import {
  exactRecordWithOptionalKeys,
  exactToolFailure,
  exactToolSuccess,
} from "./session-result-contracts";
import { toolCallerSession } from "./tool-caller-session";

export function serializeSessionStopResult(
  result: DomainResult<SessionStopResult>,
  expectedTargetSessionId: SessionId | undefined,
): string {
  const success = exactToolSuccess(result);
  if (!success) {
    const failure = exactToolFailure(
      result,
      sessionStopFailureCodes as readonly DomainFailureCode[],
    );
    if (!failure) throw new ToolContractFault();
    const error = {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    };
    if (failure.code !== "native_outcome_unknown") {
      if (failure.details !== undefined) throw new ToolContractFault();
      return JSON.stringify({ ok: false, error });
    }
    const details = exactRecordWithOptionalKeys(failure.details, ["communicator_state"], []);
    const state = exactPublicStopState(details?.communicator_state);
    if (!state) throw new ToolContractFault();
    return JSON.stringify({
      ok: false,
      error: { ...error, details: { communicator_state: publicStopState(state) } },
    });
  }
  const value = exactRecordWithOptionalKeys(
    success.value,
    ["sessionId", "communicatorState", "nativeOutcome"],
    [],
  );
  const state = exactStopState(value?.communicatorState);
  if (!value || !state) throw new ToolContractFault();
  if (
    expectedTargetSessionId === undefined ||
    value.sessionId !== expectedTargetSessionId ||
    (value.nativeOutcome !== "already_idle" && value.nativeOutcome !== "interrupted")
  ) {
    throw new ToolContractFault();
  }
  return JSON.stringify({
    ok: true,
    value: {
      session_id: value.sessionId,
      communicator_state: publicStopState(state),
      native_outcome: value.nativeOutcome,
    },
  });
}

function exactStopState(value: unknown):
  | {
      readonly outcome: "applied";
      readonly requestsTerminalized: number;
      readonly targetStopped: number;
      readonly sourceStopped: number;
    }
  | undefined {
  const state = exactRecordWithOptionalKeys(
    value,
    ["outcome", "requestsTerminalized", "targetStopped", "sourceStopped"],
    [],
  );
  if (!state) return undefined;
  const requests = state.requestsTerminalized;
  const target = state.targetStopped;
  const source = state.sourceStopped;
  return state.outcome === "applied" &&
    validStopCounter(requests) &&
    validStopCounter(target) &&
    validStopCounter(source) &&
    target + source === requests
    ? {
        outcome: "applied",
        requestsTerminalized: requests,
        targetStopped: target,
        sourceStopped: source,
      }
    : undefined;
}

function exactPublicStopState(value: unknown):
  | {
      readonly outcome: "applied";
      readonly requestsTerminalized: number;
      readonly targetStopped: number;
      readonly sourceStopped: number;
    }
  | undefined {
  const state = exactRecordWithOptionalKeys(
    value,
    ["outcome", "requests_terminalized", "target_stopped", "source_stopped"],
    [],
  );
  return state
    ? exactStopState({
        outcome: state.outcome,
        requestsTerminalized: state.requests_terminalized,
        targetStopped: state.target_stopped,
        sourceStopped: state.source_stopped,
      })
    : undefined;
}

function publicStopState(state: {
  readonly outcome: "applied";
  readonly requestsTerminalized: number;
  readonly targetStopped: number;
  readonly sourceStopped: number;
}): Record<string, unknown> {
  return {
    outcome: state.outcome,
    requests_terminalized: state.requestsTerminalized,
    target_stopped: state.targetStopped,
    source_stopped: state.sourceStopped,
  };
}

function validStopCounter(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= pendingRequestsPerWorkspaceHardCeiling
  );
}

export function createSessionStopTool(
  ports: Omit<SessionStopPorts, "approval">,
  workspaceKey: WorkspaceKey,
  invocationDeadlineMs?: () => number,
  policy: PolicyDecision = "deny",
): InternalToolContract<SessionStopToolArguments> {
  return {
    description:
      "Stop a visible root session only when explicitly allowed by static plugin policy. Pending communicator requests are terminalized before the public native interruption.",
    args: sessionStopArgumentsSchema,
    async execute(arguments_, context) {
      const caller = toolCallerSession(context.sessionID);
      let deadlineMs: number | undefined;
      try {
        deadlineMs = invocationDeadlineMs?.() ?? Date.now() + 3_600_000;
      } catch {
        throw new Error("Stop invocation deadline is invalid.");
      }
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
        throw new Error("Stop invocation deadline is invalid.");
      }
      const target = validateSessionId(arguments_.session_id);
      const result =
        caller.ok && target.ok
          ? await stopSession(
              {
                ...ports,
                approval: invocationStopApproval(policy),
              },
              {
                workspaceKey,
                sourceSessionId: caller.value,
                abort: context.abort,
                deadlineMs,
              },
              arguments_,
            )
          : caller.ok
            ? domainFailure(
                "invalid_arguments",
                target.ok ? "Session ID is malformed." : target.message,
                false,
              )
            : caller;
      return serializeSessionStopResult(result, target.ok ? target.value : undefined);
    },
  };
}
