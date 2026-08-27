import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { StartOperation } from "../domain/session-start";
import type { SessionStartContext, SessionStartPorts } from "./session-start-application";
import type { StartStoreResult } from "./session-start-ports";
import { StartEffectContractFault, startStoreFailure } from "./start-session-effects";

export async function approvePreparedStart(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  prepared: {
    readonly operation: StartOperation;
    readonly argumentsSha256: StartOperation["argumentsSha256"];
  },
): Promise<DomainResult<true>> {
  if (ports.policy.decision === "allow") return { ok: true, value: true };
  const approval =
    ports.policy.decision === "deny"
      ? "denied_by_policy"
      : await ports.approval.requestStartApproval(
          {
            workspaceKey: context.workspaceKey,
            sourceSessionId: context.sourceSessionId,
            argumentsSha256: prepared.argumentsSha256,
          },
          { abort: context.abort, deadlineMs: context.deadlineMs },
        );
  if (approval !== "approved" && approval !== "rejected" && approval !== "denied_by_policy") {
    throw new StartEffectContractFault("The start approval adapter returned an unknown outcome.");
  }
  if (approval === "approved") return { ok: true, value: true };
  let released: StartStoreResult;
  try {
    released = await ports.starts.rejectPreparedStart({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: prepared.operation.id,
      nowMs: ports.clock.nowMs(),
      state: approval === "denied_by_policy" ? "policy_denied" : "approval_rejected",
    });
  } catch (cause: unknown) {
    return startStoreFailure(
      cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
  if (!released.ok) return startStoreFailure(released.code);
  if (approval === "denied_by_policy") {
    return domainFailure("permission_denied", "Session start is denied by policy.", false, {
      operation: released.operation,
    });
  }
  return domainFailure("approval_rejected", "Session start approval was rejected.", false, {
    operation: released.operation,
  });
}
