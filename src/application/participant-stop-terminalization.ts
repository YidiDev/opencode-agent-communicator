import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import type { RequestMetadata } from "../domain/request-types";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import type { SessionStopPersistencePort } from "./session-stop-ports";
import { inspectStoppedRequests } from "./stop-session-operations";

export class ParticipantStopTerminalizationFault extends Error {
  constructor(
    readonly code: "ownership_lost" | "storage_failure" | "port_contract_violation",
    cause?: unknown,
  ) {
    super(`Participant stop terminalization failed: ${code}.`, { cause });
  }
}

export async function terminalizeStoppedParticipant(input: {
  readonly requests: SessionStopPersistencePort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly stoppedSessionId: SessionId;
}): Promise<readonly RequestMetadata[]> {
  let raw: unknown;
  try {
    raw = await input.requests.stopPendingRequests({
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      stoppedSessionId: input.stoppedSessionId,
    });
  } catch (cause: unknown) {
    throw new ParticipantStopTerminalizationFault(
      cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_failure",
      cause,
    );
  }
  const inspected = inspectStoppedRequests(raw, input.workspaceKey, input.stoppedSessionId);
  if (!inspected.ok) {
    throw new ParticipantStopTerminalizationFault(
      inspected.error.code === "ownership_lost" ? "ownership_lost" : "storage_failure",
    );
  }
  for (const request of inspected.value) {
    notifyTerminalSafely(
      input.notifications,
      createTerminalNotificationEvent(
        request as RequestMetadata & {
          readonly resolutionState: Exclude<RequestMetadata["resolutionState"], "pending">;
        },
      ),
    );
  }
  return inspected.value;
}
