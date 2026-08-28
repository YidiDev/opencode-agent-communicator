import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import { boundedExternalCall } from "./bounded-external-call";
import type { CurrentRootMembership } from "./delivery-ports";
import { inspectMembership } from "./message-recovery-boundaries";
import type { SessionSendContext, SessionSendPorts } from "./session-message-delivery-contracts";

// biome-ignore format: keep the bounded membership call visually linear.
export async function readSessionSendMembership(
  ports: SessionSendPorts,
  context: SessionSendContext,
  target: SessionId,
): Promise<DomainResult<CurrentRootMembership>> {
  const operation = () =>
    ports.membership.readCurrentRoots(
      context.workspaceKey,
      context.sourceSessionId,
      target,
    );
  if (context.deadlineMs !== undefined) {
    const result = await boundedExternalCall(operation, context.abort, context.deadlineMs);
    if (result.kind === "expired") {
      return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
    }
    if (result.kind === "rejected") {
      return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
    }
    const membership = inspectMembership(result.value);
    return membership
      ? { ok: true, value: membership }
      : domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  try {
    const membership = inspectMembership(await operation());
    return membership
      ? { ok: true, value: membership }
      : domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  } catch {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
}
