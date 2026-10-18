import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { StartOperation } from "../domain/session-start";
import type { SessionStartContext, SessionStartPorts } from "./session-start-application";
import type { StartStoreResult } from "./session-start-ports";
import { startStoreFailure } from "./start-session-effects";

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
  let released: StartStoreResult;
  try {
    released = await ports.starts.rejectPreparedStart({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: prepared.operation.id,
      nowMs: ports.clock.nowMs(),
      state: "policy_denied",
    });
  } catch (cause: unknown) {
    return startStoreFailure(
      cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
  if (!released.ok) return startStoreFailure(released.code);
  return domainFailure("permission_denied", "Session start is denied by policy.", false, {
    operation: released.operation,
  });
}
