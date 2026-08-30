import { runUntilAborted } from "../application/abortable-operation";
import type {
  SessionReadApprovalBinding,
  SessionReadApprovalPort,
} from "../application/session-read-ports";
import { snapshotDataRecord } from "../application/strict-port-boundaries";
import { sessionReadLimits, sessionReadProjectionVersion } from "../domain/session-read";
import { validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey } from "../domain/workspaces";
import type { StructuralToolContext } from "./contracts";
import { ToolContractFault } from "./contracts";

const BINDING_KEYS = new Set([
  "workspaceKey",
  "sourceSessionId",
  "targetSessionId",
  "projectionVersion",
  "mode",
  "lineLimit",
  "aggregateByteCap",
  "cursorSha256",
]);

function validBinding(value: unknown): value is SessionReadApprovalBinding {
  const binding = snapshotDataRecord(value, BINDING_KEYS.size);
  if (!binding || Object.keys(binding).some((key) => !BINDING_KEYS.has(key))) return false;
  const cursor = binding.cursorSha256;
  return (
    validateWorkspaceKey(binding.workspaceKey).ok &&
    validateSessionId(binding.sourceSessionId).ok &&
    validateSessionId(binding.targetSessionId).ok &&
    binding.sourceSessionId !== binding.targetSessionId &&
    binding.projectionVersion === sessionReadProjectionVersion &&
    (binding.mode === "tail" || binding.mode === "before" || binding.mode === "after") &&
    Number.isInteger(binding.lineLimit) &&
    (binding.lineLimit as number) >= 1 &&
    (binding.lineLimit as number) <= sessionReadLimits.maxLines &&
    binding.aggregateByteCap === sessionReadLimits.maxContentBytes &&
    (cursor === undefined || (typeof cursor === "string" && /^[a-f0-9]{64}$/.test(cursor)))
  );
}

function validControl(value: unknown): value is Parameters<
  SessionReadApprovalPort["requestReadApproval"]
>[1] & {
  readonly deadlineMs: number;
} {
  const control = snapshotDataRecord(value, 2);
  return (
    !!control &&
    Object.keys(control).length === 2 &&
    Object.keys(control).every((key) => key === "abort" || key === "deadlineMs") &&
    control.abort instanceof AbortSignal &&
    Number.isSafeInteger(control.deadlineMs) &&
    (control.deadlineMs as number) > 0
  );
}

function approvalResource(binding: SessionReadApprovalBinding, deadlineMs: number): string {
  return [
    "op=session_read",
    `projection_version=${binding.projectionVersion}`,
    `workspace=${encodeURIComponent(binding.workspaceKey)}`,
    `source=${binding.sourceSessionId}`,
    `target=${binding.targetSessionId}`,
    `mode=${binding.mode}`,
    `line_limit=${binding.lineLimit}`,
    `aggregate_byte_cap=${binding.aggregateByteCap}`,
    `cursor_sha256=${binding.cursorSha256 ?? "none"}`,
    `deadline_ms=${deadlineMs}`,
  ].join(";");
}

export function invocationSessionReadApproval(
  context: StructuralToolContext,
): SessionReadApprovalPort {
  let requested = false;
  const approval: SessionReadApprovalPort = {
    async requestReadApproval(
      binding: SessionReadApprovalBinding,
      control: Parameters<SessionReadApprovalPort["requestReadApproval"]>[1],
    ) {
      if (requested) throw new ToolContractFault();
      requested = true;
      if (!validBinding(binding) || !validControl(control) || typeof context.ask !== "function") {
        throw new ToolContractFault();
      }
      if (control.abort.aborted) return "rejected";
      try {
        const result = await runUntilAborted(
          control.abort,
          () =>
            context.ask?.({
              permission: "session_read",
              patterns: [approvalResource(binding, control.deadlineMs)],
              always: [],
              metadata: {
                operation: "session_read",
                projection_version: binding.projectionVersion,
                workspace_key: binding.workspaceKey,
                source_session_id: binding.sourceSessionId,
                target_session_id: binding.targetSessionId,
                mode: binding.mode,
                line_limit: binding.lineLimit,
                aggregate_byte_cap: binding.aggregateByteCap,
                cursor_sha256: binding.cursorSha256 ?? null,
                deadline_ms: control.deadlineMs,
              },
            }) ?? Promise.reject(new ToolContractFault()),
        );
        return result.kind === "settled" && !control.abort.aborted ? "approved" : "rejected";
      } catch {
        return "rejected";
      }
    },
  };
  return Object.freeze(approval);
}
