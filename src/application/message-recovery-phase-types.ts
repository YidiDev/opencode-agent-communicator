import type { FencingToken } from "../domain/ownership";
import type { WorkspaceKey } from "../domain/workspaces";
import type { StartupRecoveryBarrier } from "./delivery-ports";

export interface MessageRecoveryPhaseInput {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: FencingToken;
  readonly startupBarrier: StartupRecoveryBarrier;
  readonly abort: AbortSignal;
  readonly deadlineMs?: number;
  readonly limit: number;
}
