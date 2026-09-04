import type {
  CurrentWorkspaceMembershipPort,
  NativeQueueAdmissionPort,
  SessionReadPresencePort,
} from "../../application/delivery-ports";
import type { NativeParticipantStopActivityPort } from "../../application/participant-stop-ports";
import type {
  NativeSteerAdmissionPort,
  RequestParticipantActivityPort,
} from "../../application/request-ports";
import type { HostHealthPort } from "../../domain/host";
import type { VisibleRootSessionPort } from "../../domain/sessions";
import { validateSessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import { validateWorkspaceKey } from "../../domain/workspaces";
import { isAuthoritativeClientRejection, parseAdmissionResponse } from "./opencode-1-18-admission";
import {
  combineRootSets,
  mergedActivityStatus,
  parseActiveMap,
  parseActivityMap,
  parseSessionArray,
  parseV2SessionArray,
} from "./opencode-1-18-sessions";
import { envelopeData, NativeAdapterFault } from "./opencode-1-18-surface";

interface ObservationContext {
  readonly active: (signal?: AbortSignal) => Promise<unknown>;
  readonly configuredWorkspace: WorkspaceKey;
  readonly health: (signal?: AbortSignal) => Promise<unknown>;
  readonly listArchivedRoots: (signal?: AbortSignal) => Promise<unknown>;
  readonly listMetadata: (signal?: AbortSignal) => Promise<unknown>;
  readonly listVisibleRoots: (signal?: AbortSignal) => Promise<unknown>;
  readonly now: () => number;
  readonly readStatus: (signal?: AbortSignal) => Promise<unknown>;
}

export function createObservationOperations(
  context: ObservationContext,
): HostHealthPort &
  VisibleRootSessionPort &
  CurrentWorkspaceMembershipPort &
  SessionReadPresencePort &
  RequestParticipantActivityPort &
  NativeParticipantStopActivityPort {
  return {
    async readHealth(signal?: AbortSignal): Promise<unknown> {
      return envelopeData(await context.health(signal), "Host health");
    },
    async readVisibleRoots(includeArchived, signal?: AbortSignal) {
      const archivedRequest = includeArchived ? context.listArchivedRoots(signal) : undefined;
      const [listedResult, visibleRootsResult, archivedRootsResult, statusResult, activeResult] =
        await Promise.all([
          context.listMetadata(signal),
          context.listVisibleRoots(signal),
          archivedRequest,
          context.readStatus(signal),
          context.active(signal),
        ]);
      const listed = parseV2SessionArray(listedResult);
      const visibleRoots = parseSessionArray(
        envelopeData(visibleRootsResult, "Legacy visible root listing"),
        "Visible root listing",
      );
      const archivedRoots =
        archivedRootsResult === undefined
          ? []
          : parseSessionArray(
              envelopeData(archivedRootsResult, "Legacy archived root listing"),
              "Archived root listing",
            );
      const roots = combineRootSets(visibleRoots, archivedRoots);
      const statusData = parseActivityMap(
        envelopeData(statusResult, "Legacy status"),
        "Legacy status",
      );
      const activeData = parseActiveMap(activeResult);
      const listedById = new Map(listed.map((session) => [session.id, session]));
      const observedAtMs = context.now();
      if (!Number.isFinite(observedAtMs) || observedAtMs < 0) {
        throw new NativeAdapterFault("Observation clock is invalid.");
      }
      return roots.map((root) => {
        const display = listedById.get(root.id) ?? root;
        return {
          id: root.id,
          title: display.title,
          updatedAtMs: display.updatedAtMs,
          isArchived: root.isArchived,
          status: mergedActivityStatus(statusData, activeData, root.id),
          observedAtMs,
        };
      });
    },
    async readCurrentRoots(workspaceKey, sourceSessionId, targetSessionId, abort?: AbortSignal) {
      assertWorkspaceBinding(workspaceKey, context.configuredWorkspace);
      const roots = parseSessionArray(
        envelopeData(await context.listVisibleRoots(abort), "Legacy current root listing"),
        "Current root listing",
      );
      const byId = new Map(roots.map((root) => [root.id, root]));
      return {
        sourceVisible: byId.has(sourceSessionId),
        targetVisible: byId.has(targetSessionId),
        sourceTitle: byId.get(sourceSessionId)?.title,
      };
    },
    async observeSessionReadPresence(workspaceKey, sourceSessionId, targetSessionId, abort) {
      assertWorkspaceBinding(workspaceKey, context.configuredWorkspace);
      if (!validateSessionId(sourceSessionId).ok || !validateSessionId(targetSessionId).ok) {
        throw new NativeAdapterFault("Session read participant identity is malformed.");
      }
      if (!(abort instanceof AbortSignal) || abort.aborted) {
        throw new NativeAdapterFault("Session read presence observation was aborted.");
      }
      const [statusResult, activeResult] = await Promise.all([
        context.readStatus(abort),
        context.active(abort),
      ]);
      if (abort.aborted) {
        throw new NativeAdapterFault("Session read presence observation was aborted.");
      }
      const rootsResult = await context.listVisibleRoots(abort);
      if (abort.aborted) {
        throw new NativeAdapterFault("Session read presence observation was aborted.");
      }
      const roots = parseSessionArray(
        envelopeData(rootsResult, "Legacy current root listing"),
        "Current root listing",
      );
      const statuses = parseActivityMap(
        envelopeData(statusResult, "Legacy status"),
        "Legacy status",
      );
      const active = parseActiveMap(activeResult);
      const observedAtMs = context.now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new NativeAdapterFault("Observation clock is invalid.");
      }
      const visible = new Set(roots.map((root) => root.id));
      return Object.freeze({
        sourceVisible: visible.has(sourceSessionId),
        targetVisible: visible.has(targetSessionId),
        targetStatus: mergedActivityStatus(statuses, active, targetSessionId),
        observedAtMs,
      });
    },
    async observeRequestParticipants(workspaceKey, sourceSessionId, targetSessionId, abort) {
      assertWorkspaceBinding(workspaceKey, context.configuredWorkspace);
      if (!validateSessionId(sourceSessionId).ok || !validateSessionId(targetSessionId).ok) {
        throw new NativeAdapterFault("Request participant identity is malformed.");
      }
      if (abort.aborted)
        throw new NativeAdapterFault("Request participant observation was aborted.");
      const [rootsResult, statusResult, activeResult] = await Promise.all([
        context.listVisibleRoots(abort),
        context.readStatus(abort),
        context.active(abort),
      ]);
      const roots = parseSessionArray(
        envelopeData(rootsResult, "Legacy current root listing"),
        "Current root listing",
      );
      if (abort.aborted)
        throw new NativeAdapterFault("Request participant observation was aborted.");
      const statuses = parseActivityMap(
        envelopeData(statusResult, "Legacy status"),
        "Legacy status",
      );
      const active = parseActiveMap(activeResult);
      const visible = new Set(roots.map((root) => root.id));
      return Object.freeze({
        sourceVisible: visible.has(sourceSessionId),
        targetVisible: visible.has(targetSessionId),
        targetStatus: mergedActivityStatus(statuses, active, targetSessionId),
      });
    },
    async observeParticipantActivities(workspaceKey, participantSessionIds, abort) {
      assertWorkspaceBinding(workspaceKey, context.configuredWorkspace);
      if (
        !Array.isArray(participantSessionIds) ||
        participantSessionIds.length < 1 ||
        participantSessionIds.length > 64 ||
        participantSessionIds.some((id) => !validateSessionId(id).ok)
      ) {
        throw new NativeAdapterFault("Participant activity identities are malformed.");
      }
      if (abort.aborted) {
        return participantSessionIds.map((sessionId) => ({ sessionId, activity: "unknown" }));
      }
      const [rootsResult, statusResult, activeResult] = await Promise.all([
        context.listVisibleRoots(abort),
        context.readStatus(abort),
        context.active(abort),
      ]);
      if (abort.aborted) {
        return participantSessionIds.map((sessionId) => ({ sessionId, activity: "unknown" }));
      }
      const roots = parseSessionArray(
        envelopeData(rootsResult, "Legacy current root listing"),
        "Current root listing",
      );
      const visible = new Set(roots.map((root) => root.id));
      const statuses = parseActivityMap(
        envelopeData(statusResult, "Legacy status"),
        "Legacy status",
      );
      const active = parseActiveMap(activeResult);
      return Object.freeze(
        participantSessionIds.map((sessionId) =>
          Object.freeze({
            sessionId,
            activity: visible.has(sessionId)
              ? mergedActivityStatus(statuses, active, sessionId)
              : ("not_visible" as const),
          }),
        ),
      );
    },
  };
}

function assertWorkspaceBinding(supplied: WorkspaceKey, configured: WorkspaceKey): void {
  const workspace = validateWorkspaceKey(supplied);
  if (!workspace.ok || workspace.value !== configured) {
    throw new NativeAdapterFault("Workspace binding does not match this native adapter.");
  }
}

interface AdmissionContext {
  readonly directory?: string;
  readonly now: () => number;
  readonly prompt: (
    parameters: {
      readonly sessionID: string;
      readonly id: string;
      readonly prompt: { readonly text: string };
      readonly delivery: "queue" | "steer";
      readonly resume: true;
    },
    options: { readonly signal: AbortSignal; readonly fetch?: typeof globalThis.fetch },
  ) => Promise<unknown>;
  readonly serverUrl?: URL;
}

export function createAdmissionOperations(
  context: AdmissionContext,
): NativeQueueAdmissionPort & NativeSteerAdmissionPort {
  async function admit(
    request: Parameters<NativeQueueAdmissionPort["queueMessage"]>[0],
    delivery: "queue" | "steer",
  ) {
    if (request.abort.aborted) return { kind: "unknown" } as const;
    let response: unknown;
    try {
      response = await context.prompt(
        {
          sessionID: request.targetSessionId,
          id: request.nativeMessageId,
          prompt: { text: request.envelope },
          delivery,
          resume: true,
        },
        { signal: request.abort },
      );
    } catch (_cause: unknown) {
      return { kind: "unknown" } as const;
    }
    if (
      context.serverUrl !== undefined &&
      context.directory !== undefined &&
      (await isAuthoritativeClientRejection(response, request.abort.aborted, {
        abort: request.abort,
        method: "POST",
        serverUrl: context.serverUrl,
        endpointPath: `/api/session/${encodeURIComponent(request.targetSessionId)}/prompt`,
        directory: context.directory,
        targetSessionId: request.targetSessionId,
        messageId: request.nativeMessageId,
        messageIdBodyKey: "id",
      }))
    ) {
      return { kind: "definitive_rejection" } as const;
    }
    return delivery === "steer"
      ? parseAdmissionResponse(response, request, context.now, "steer")
      : parseAdmissionResponse(response, request, context.now);
  }

  return {
    queueMessage(message) {
      return admit(message, "queue");
    },
    steerRequest(request) {
      return admit(request, "steer");
    },
  };
}
