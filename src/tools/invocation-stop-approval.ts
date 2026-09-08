import type { SessionStopApprovalPort } from "../application/session-stop-ports";
import { validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey } from "../domain/workspaces";
import type { StructuralToolContext } from "./contracts";
import { ToolContractFault } from "./contracts";
import {
  exactApprovalRecord,
  hasExactApprovalControl,
  isSha256Digest,
} from "./invocation-approval-contracts";

function approvalResource(
  binding: Parameters<SessionStopApprovalPort["requestStopApproval"]>[0],
  deadlineMs: number | undefined,
): string {
  return [
    "op=session_stop",
    `workspace=${encodeURIComponent(binding.workspaceKey)}`,
    `source=${binding.sourceSessionId}`,
    `target=${binding.targetSessionId}`,
    `reason_sha256=${binding.reasonSha256}`,
    `deadline_ms=${deadlineMs ?? "none"}`,
  ].join(";");
}

/** A fresh single-use capability is created inside each tool invocation; no policy port can replace it. */
export function invocationStopApproval(
  context: StructuralToolContext,
  expected: {
    readonly workspaceKey: Parameters<
      SessionStopApprovalPort["requestStopApproval"]
    >[0]["workspaceKey"];
    readonly sourceSessionId: Parameters<
      SessionStopApprovalPort["requestStopApproval"]
    >[0]["sourceSessionId"];
    readonly targetSessionId: Parameters<
      SessionStopApprovalPort["requestStopApproval"]
    >[0]["targetSessionId"];
    readonly abort: AbortSignal;
    readonly deadlineMs: number;
  },
): SessionStopApprovalPort {
  let hasRequested = false;
  return Object.freeze({
    async requestStopApproval(
      binding: Parameters<SessionStopApprovalPort["requestStopApproval"]>[0],
      control: Parameters<SessionStopApprovalPort["requestStopApproval"]>[1],
    ): Promise<"approved" | "rejected"> {
      const inspected = exactApprovalRecord(binding, [
        "workspaceKey",
        "sourceSessionId",
        "targetSessionId",
        "reasonSha256",
      ]);
      if (
        hasRequested ||
        inspected === undefined ||
        expected.abort !== context.abort ||
        expected.sourceSessionId !== context.sessionID ||
        !validateWorkspaceKey(inspected.workspaceKey).ok ||
        !validateSessionId(inspected.sourceSessionId).ok ||
        !validateSessionId(inspected.targetSessionId).ok ||
        !isSha256Digest(inspected.reasonSha256) ||
        inspected.workspaceKey !== expected.workspaceKey ||
        inspected.sourceSessionId !== expected.sourceSessionId ||
        inspected.targetSessionId !== expected.targetSessionId ||
        !hasExactApprovalControl(control, expected.abort, expected.deadlineMs) ||
        typeof context.ask !== "function"
      )
        throw new ToolContractFault();
      hasRequested = true;
      if (control.abort.aborted) return "rejected";
      try {
        const asked = Promise.resolve(
          context.ask({
            permission: "session_stop",
            patterns: [approvalResource(binding, control.deadlineMs)],
            always: [],
            metadata: {
              operation: "session_stop",
              source_session_id: binding.sourceSessionId,
              target_session_id: binding.targetSessionId,
              reason_sha256: binding.reasonSha256,
              deadline_ms: control.deadlineMs ?? null,
              ...(context.messageID === undefined
                ? {}
                : { invocation_message_id: context.messageID }),
            },
          }),
        );
        asked.catch(() => undefined);
        const expired = new Promise<"expired">((resolve) => {
          const reject = (): void => resolve("expired");
          if (control.abort.aborted) reject();
          else control.abort.addEventListener("abort", reject, { once: true });
        });
        const result = await Promise.race([asked.then(() => "approved" as const), expired]);
        return result === "approved" && !control.abort.aborted ? "approved" : "rejected";
      } catch {
        return "rejected";
      }
    },
  });
}
