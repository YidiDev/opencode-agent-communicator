import { type SessionStartPorts, startSession } from "../application/start-session";
import type { DomainFailureCode, DomainResult } from "../domain/results";
import type { StartOperation } from "../domain/session-start";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionStartToolArguments,
  sessionStartArgumentsSchema,
  sessionStartFailureCodes,
  ToolContractFault,
} from "./contracts";
import { invocationStartApproval } from "./invocation-start-approval";
import { publicStartOperation } from "./public-values";
import {
  exactRecordWithOptionalKeys,
  exactStartOperation,
  exactToolFailure,
  exactToolSuccess,
} from "./session-result-contracts";
import { toolCallerSession } from "./tool-caller-session";

export interface SessionStartToolScope {
  readonly workspaceKey: WorkspaceKey;
  readonly invocationDeadlineMs: () => number;
}

export function serializeSessionStartResult(
  result: DomainResult<StartOperation>,
  expected: {
    readonly workspaceKey: WorkspaceKey;
    readonly sourceSessionId: string;
    readonly idempotencyKey: string;
  },
): string {
  const success = exactToolSuccess(result);
  if (success) {
    const operation = expectedStartOperation(success.value, expected);
    if (!operation) throw new ToolContractFault();
    return JSON.stringify({ ok: true, value: publicStartOperation(operation) });
  }
  const failure = exactToolFailure(
    result,
    sessionStartFailureCodes as readonly DomainFailureCode[],
  );
  if (!failure) throw new ToolContractFault();
  if (failure.details === undefined) {
    return JSON.stringify({ ok: false, error: publicFailure(failure) });
  }
  const details = exactRecordWithOptionalKeys(failure.details, ["operation"], []);
  const operation = expectedStartOperation(details?.operation, expected);
  if (!operation) throw new ToolContractFault();
  return JSON.stringify({
    ok: false,
    error: { ...publicFailure(failure), details: { operation: publicStartOperation(operation) } },
  });
}

function publicFailure(failure: {
  readonly code: DomainFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}): Record<string, unknown> {
  return { code: failure.code, message: failure.message, retryable: failure.retryable };
}

function expectedStartOperation(
  value: unknown,
  expected: {
    readonly workspaceKey: WorkspaceKey;
    readonly sourceSessionId: string;
    readonly idempotencyKey: string;
  },
): StartOperation | undefined {
  const operation = exactStartOperation(value);
  return operation &&
    operation.workspaceKey === expected.workspaceKey &&
    operation.sourceSessionId === expected.sourceSessionId &&
    operation.idempotencyKey === expected.idempotencyKey
    ? operation
    : undefined;
}

export function createSessionStartTool(
  ports: Omit<SessionStartPorts, "approval">,
  scope: SessionStartToolScope,
): InternalToolContract<SessionStartToolArguments> {
  return {
    description:
      "Create one independent root session with durable source-scoped idempotency and mandatory invocation-specific approval by default.",
    args: sessionStartArgumentsSchema,
    async execute(arguments_, context) {
      const caller = toolCallerSession(context.sessionID);
      let deadlineMs: number;
      try {
        deadlineMs = scope.invocationDeadlineMs();
      } catch {
        throw new ToolContractFault();
      }
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new ToolContractFault();
      const result = caller.ok
        ? await startSession(
            {
              ...ports,
              approval: invocationStartApproval(context, {
                workspaceKey: scope.workspaceKey,
                sourceSessionId: caller.value,
                abort: context.abort,
                deadlineMs,
                clock: ports.clock,
              }),
            },
            {
              workspaceKey: scope.workspaceKey,
              sourceSessionId: caller.value,
              abort: context.abort,
              deadlineMs,
            },
            arguments_,
          )
        : caller;
      return serializeSessionStartResult(result, {
        workspaceKey: scope.workspaceKey,
        sourceSessionId: caller.ok ? caller.value : context.sessionID,
        idempotencyKey: arguments_.idempotency_key,
      });
    },
  };
}
