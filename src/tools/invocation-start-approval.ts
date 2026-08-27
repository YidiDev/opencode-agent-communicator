import { runUntilAborted } from "../application/abortable-operation";
import type { SessionStartApprovalPort } from "../application/session-start-ports";
import type { StructuralToolContext } from "./contracts";
import { ToolContractFault } from "./contracts";

function approvalResource(
  binding: Parameters<SessionStartApprovalPort["requestStartApproval"]>[0],
  deadlineMs: number | undefined,
): string {
  return [
    "op=session_start",
    `workspace=${encodeURIComponent(binding.workspaceKey)}`,
    `source=${binding.sourceSessionId}`,
    `arguments_sha256=${binding.argumentsSha256}`,
    `deadline_ms=${deadlineMs ?? "none"}`,
  ].join(";");
}

/** A fresh exact capability is bound to one invocation and one canonical argument digest. */
export function invocationStartApproval(context: StructuralToolContext): SessionStartApprovalPort {
  let hasRequested = false;
  return Object.freeze({
    async requestStartApproval(
      binding: Parameters<SessionStartApprovalPort["requestStartApproval"]>[0],
      control: Parameters<SessionStartApprovalPort["requestStartApproval"]>[1],
    ): Promise<"approved" | "rejected"> {
      if (hasRequested || typeof context.ask !== "function") throw new ToolContractFault();
      hasRequested = true;
      const ask = context.ask;
      if (control.abort.aborted) return "rejected";
      try {
        const result = await runUntilAborted(control.abort, () =>
          ask({
            permission: "session_start",
            patterns: [approvalResource(binding, control.deadlineMs)],
            always: [],
            metadata: {
              operation: "session_start",
              source_session_id: binding.sourceSessionId,
              arguments_sha256: binding.argumentsSha256,
              deadline_ms: control.deadlineMs ?? null,
              ...(context.messageID === undefined
                ? {}
                : { invocation_message_id: context.messageID }),
            },
          }),
        );
        return result.kind === "settled" && !control.abort.aborted ? "approved" : "rejected";
      } catch {
        return "rejected";
      }
    },
  });
}
