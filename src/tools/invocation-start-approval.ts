import { runUntilAborted } from "../application/abortable-operation";
import type { ClockPort } from "../application/delivery-ports";
import type { SessionStartApprovalPort } from "../application/session-start-ports";
import { createLinkedEffectControl } from "../application/startup-effect-control";
import { validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey } from "../domain/workspaces";
import type { StructuralToolContext } from "./contracts";
import { ToolContractFault } from "./contracts";
import {
  exactApprovalRecord,
  hasExactApprovalControl,
  isSha256Digest,
} from "./invocation-approval-contracts";

type StartBinding = Parameters<SessionStartApprovalPort["requestStartApproval"]>[0];

export interface InvocationStartApprovalExpected {
  readonly workspaceKey: StartBinding["workspaceKey"];
  readonly sourceSessionId: StartBinding["sourceSessionId"];
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
  readonly clock: ClockPort;
}

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
export function invocationStartApproval(
  context: StructuralToolContext,
  expected: InvocationStartApprovalExpected,
): SessionStartApprovalPort {
  let hasRequested = false;
  return Object.freeze({
    async requestStartApproval(
      binding: Parameters<SessionStartApprovalPort["requestStartApproval"]>[0],
      control: Parameters<SessionStartApprovalPort["requestStartApproval"]>[1],
    ): Promise<"approved" | "rejected"> {
      const inspected = exactApprovalRecord(binding, [
        "workspaceKey",
        "sourceSessionId",
        "argumentsSha256",
      ]);
      if (
        hasRequested ||
        inspected === undefined ||
        expected.abort !== context.abort ||
        expected.sourceSessionId !== context.sessionID ||
        !validateWorkspaceKey(inspected.workspaceKey).ok ||
        !validateSessionId(inspected.sourceSessionId).ok ||
        inspected.workspaceKey !== expected.workspaceKey ||
        inspected.sourceSessionId !== expected.sourceSessionId ||
        !isSha256Digest(inspected.argumentsSha256) ||
        !hasExactApprovalControl(control, expected.abort, expected.deadlineMs) ||
        typeof context.ask !== "function"
      ) {
        throw new ToolContractFault();
      }
      hasRequested = true;
      const ask = context.ask;
      if (control.abort.aborted) return "rejected";
      const bounded = createLinkedEffectControl({
        signals: [control.abort],
        deadlineMs: expected.deadlineMs,
        clock: expected.clock,
      });
      if (!bounded) return "rejected";
      try {
        const result = await runUntilAborted(bounded.signal, () =>
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
        return result.kind === "settled" && !bounded.signal.aborted ? "approved" : "rejected";
      } catch {
        return "rejected";
      } finally {
        bounded.dispose();
      }
    },
  });
}
