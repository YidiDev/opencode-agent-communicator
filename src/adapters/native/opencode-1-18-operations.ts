import type {
  CurrentWorkspaceMembershipPort,
  NativeQueueAdmissionPort,
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
  readonly active: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
  readonly configuredWorkspace: WorkspaceKey;
  readonly health: () => Promise<unknown>;
  readonly listArchivedRoots: () => Promise<unknown>;
  readonly listMetadata: () => Promise<unknown>;
  readonly listVisibleRoots: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
  readonly now: () => number;
  readonly readStatus: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
}

export function createObservationOperations(
  context: ObservationContext,
): HostHealthPort &
  VisibleRootSessionPort &
  CurrentWorkspaceMembershipPort &
  RequestParticipantActivityPort &
  NativeParticipantStopActivityPort {
  return {
    async readHealth(): Promise<unknown> {
      return envelopeData(await context.health(), "Host health");
    },
    async readVisibleRoots(includeArchived) {
      const archivedRequest = includeArchived ? context.listArchivedRoots() : undefined;
      const [listedResult, visibleRootsResult, archivedRootsResult, statusResult, activeResult] =
        await Promise.all([
          context.listMetadata(),
          context.listVisibleRoots(),
          archivedRequest,
          context.readStatus(),
          context.active(),
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
    async readCurrentRoots(workspaceKey, sourceSessionId, targetSessionId) {
      assertWorkspaceBinding(workspaceKey, context.configuredWorkspace);
      const roots = parseSessionArray(
        envelopeData(await context.listVisibleRoots(), "Legacy current root listing"),
        "Current root listing",
      );
      const byId = new Map(roots.map((root) => [root.id, root]));
      return {
        sourceVisible: byId.has(sourceSessionId),
        targetVisible: byId.has(targetSessionId),
        sourceTitle: byId.get(sourceSessionId)?.title,
      };
    },
    async observeRequestParticipants(workspaceKey, sourceSessionId, targetSessionId, abort) {
      assertWorkspaceBinding(workspaceKey, context.configuredWorkspace);
      if (!validateSessionId(sourceSessionId).ok || !validateSessionId(targetSessionId).ok) {
        throw new NativeAdapterFault("Request participant identity is malformed.");
      }
      if (abort.aborted)
        throw new NativeAdapterFault("Request participant observation was aborted.");
      const [rootsResult, statusResult, activeResult] = await Promise.all([
        context.listVisibleRoots({ signal: abort }),
        context.readStatus({ signal: abort }),
        context.active({ signal: abort }),
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
    async observeParticipantActivity(workspaceKey, participantSessionId, abort) {
      assertWorkspaceBinding(workspaceKey, context.configuredWorkspace);
      if (!validateSessionId(participantSessionId).ok || abort.aborted) return "unknown";
      const [rootsResult, statusResult, activeResult] = await Promise.all([
        context.listVisibleRoots({ signal: abort }),
        context.readStatus({ signal: abort }),
        context.active({ signal: abort }),
      ]);
      if (abort.aborted) return "unknown";
      const roots = parseSessionArray(
        envelopeData(rootsResult, "Legacy current root listing"),
        "Current root listing",
      );
      if (!roots.some((root) => root.id === participantSessionId)) return "not_visible";
      const statuses = parseActivityMap(
        envelopeData(statusResult, "Legacy status"),
        "Legacy status",
      );
      const active = parseActiveMap(activeResult);
      return mergedActivityStatus(statuses, active, participantSessionId);
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
  readonly now: () => number;
  readonly prompt: (
    parameters: {
      readonly sessionID: string;
      readonly id: string;
      readonly prompt: { readonly text: string };
      readonly delivery: "queue" | "steer";
      readonly resume: true;
    },
    options: { readonly signal: AbortSignal },
  ) => Promise<unknown>;
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
    if (isAuthoritativeClientRejection(response, request.abort.aborted, request.targetSessionId)) {
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
