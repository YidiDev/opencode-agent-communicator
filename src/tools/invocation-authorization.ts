import { runUntilAborted } from "../application/abortable-operation";
import type { MessageAuthorizationPort, OperationControl } from "../application/delivery-ports";
import type { RequestAuthorizationPort } from "../application/request-authorization-port";
import type { PolicyDecision } from "../domain/authorization-policy";
import type { StructuralApprovalInput, StructuralToolContext } from "../tools/contracts";

async function decide(
  policy: PolicyDecision,
  context: StructuralToolContext,
  control: OperationControl,
  approval: StructuralApprovalInput,
): Promise<{ readonly kind: "allow" | "deny" | "approval_rejected" }> {
  if (policy === "allow") return { kind: "allow" };
  if (policy === "deny") return { kind: "deny" };
  if (typeof context.ask !== "function" || control.abort.aborted)
    return { kind: "approval_rejected" };
  try {
    const settled = await runUntilAborted(
      control.abort,
      () => context.ask?.(approval) ?? Promise.reject(),
    );
    return settled.kind === "settled" && !control.abort.aborted
      ? { kind: "allow" }
      : { kind: "approval_rejected" };
  } catch {
    return { kind: "approval_rejected" };
  }
}

export function invocationMessageAuthorization(
  policy: PolicyDecision,
  context: StructuralToolContext,
): MessageAuthorizationPort {
  return Object.freeze({
    async authorizeMessage(
      binding: Parameters<MessageAuthorizationPort["authorizeMessage"]>[0],
      control: Parameters<MessageAuthorizationPort["authorizeMessage"]>[1],
    ) {
      return decide(policy, context, control, {
        permission: "session_send",
        patterns: [
          [
            "op=session_send",
            `workspace=${encodeURIComponent(binding.workspaceKey)}`,
            `source=${binding.sourceSessionId}`,
            `target=${binding.targetSessionId}`,
            `content_sha256=${binding.contentSha256}`,
            `content_bytes=${binding.contentByteLength}`,
            `deadline_ms=${control.deadlineMs ?? "none"}`,
          ].join(";"),
        ],
        always: [],
        metadata: { ...binding, deadline_ms: control.deadlineMs ?? null },
      });
    },
  });
}

export function invocationRequestAuthorization(
  policies: Readonly<{ ask: PolicyDecision; wait: PolicyDecision }>,
  context: StructuralToolContext,
): RequestAuthorizationPort {
  return Object.freeze({
    async authorizeRequest(
      binding: Parameters<RequestAuthorizationPort["authorizeRequest"]>[0],
      control: Parameters<RequestAuthorizationPort["authorizeRequest"]>[1],
    ) {
      return decide(policies[binding.operation], context, control, {
        permission: `session_${binding.operation}`,
        patterns: [
          [
            `op=session_${binding.operation}`,
            `workspace=${encodeURIComponent(binding.workspaceKey)}`,
            `source=${binding.sourceSessionId}`,
            `target=${binding.targetSessionId}`,
            `payload_sha256=${binding.payloadSha256}`,
            `payload_bytes=${binding.payloadByteLength}`,
            `timeout_seconds=${binding.timeoutSeconds}`,
            `created_at_ms=${binding.createdAtMs}`,
            `deadline_at_ms=${binding.deadlineAtMs}`,
            `invocation_deadline_ms=${control.deadlineMs ?? "none"}`,
          ].join(";"),
        ],
        always: [],
        metadata: { ...binding, invocation_deadline_ms: control.deadlineMs ?? null },
      });
    },
  });
}
