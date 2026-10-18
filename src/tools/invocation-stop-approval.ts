import type { SessionStopApprovalPort } from "../application/session-stop-ports";
import type { PolicyDecision } from "../domain/authorization-policy";

/** Static v2 policy adapter. No host prompt exists and cancellation always fails closed. */
export function invocationStopApproval(
  policy: PolicyDecision | unknown,
  _legacyExpected?: unknown,
): SessionStopApprovalPort {
  return Object.freeze({
    async requestStopApproval(
      _binding: Parameters<SessionStopApprovalPort["requestStopApproval"]>[0],
      control: Parameters<SessionStopApprovalPort["requestStopApproval"]>[1],
    ) {
      return policy === "allow" && !control.abort.aborted ? "approved" : "rejected";
    },
  });
}
