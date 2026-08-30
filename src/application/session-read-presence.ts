import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { SessionReadPresence, SessionReadPresencePort } from "./delivery-ports";
import {
  type SessionReadCallScope,
  sessionReadVisibilityFailure,
  snapshotSessionReadPresence,
} from "./session-read-pagination";

/** Observes and validates the exact presence snapshot used by a transcript disclosure guard. */
export async function observeSessionReadPresence(
  scope: SessionReadCallScope,
  presence: SessionReadPresencePort,
  workspace: WorkspaceKey,
  source: SessionId,
  target: SessionId,
): Promise<DomainResult<SessionReadPresence>> {
  const settled = await scope.run(() =>
    presence.observeSessionReadPresence(workspace, source, target, scope.signal),
  );
  if (settled.kind === "expired") {
    return domainFailure("deadline_expired", "Session read deadline expired.", false);
  }
  if (settled.kind === "rejected") {
    return domainFailure("native_unavailable", "Session read presence is unavailable.", true);
  }
  const value = snapshotSessionReadPresence(settled.value);
  if (!value) {
    return domainFailure("native_unavailable", "Session read presence is unavailable.", true);
  }
  const visibility = sessionReadVisibilityFailure(value);
  if (visibility) return visibility;
  if (value.targetStatus === "unknown") {
    return domainFailure("native_unavailable", "Target status is unavailable.", true);
  }
  return { ok: true, value };
}
