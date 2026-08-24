import type { Sha256Digest } from "../domain/message-payload";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { OperationControl } from "./delivery-ports";
import { snapshotDataRecord } from "./strict-port-boundaries";

export type RequestAuthorizationOperation = "ask" | "wait";
export type RequestAuthorizationDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny" }
  | { readonly kind: "approval_rejected" };

export function inspectRequestAuthorizationDecision(
  value: unknown,
): RequestAuthorizationDecision | undefined {
  const decision = snapshotDataRecord(value, 1);
  return decision &&
    Object.keys(decision).length === 1 &&
    (decision.kind === "allow" || decision.kind === "deny" || decision.kind === "approval_rejected")
    ? { kind: decision.kind }
    : undefined;
}

export interface RequestAuthorizationPort {
  authorizeRequest(
    binding: {
      readonly workspaceKey: WorkspaceKey;
      readonly sourceSessionId: SessionId;
      readonly targetSessionId: SessionId;
      readonly operation: RequestAuthorizationOperation;
      readonly payloadSha256: Sha256Digest;
      readonly payloadByteLength: number;
      readonly timeoutSeconds: number;
      readonly createdAtMs: number;
      readonly deadlineAtMs: number;
    },
    control: OperationControl,
  ): Promise<RequestAuthorizationDecision>;
}
