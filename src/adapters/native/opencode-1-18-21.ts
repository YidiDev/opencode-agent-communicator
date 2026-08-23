import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  CurrentWorkspaceMembershipPort,
  NativeQueueAdmissionPort,
} from "../../application/delivery-ports";
import type { NativeSteerAdmissionPort } from "../../application/request-ports";
import type { HostHealthPort } from "../../domain/host";
import type { RootSessionObservation, VisibleRootSessionPort } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import { validateWorkspaceKey } from "../../domain/workspaces";
import {
  isAuthoritativeClientRejection,
  parseAdmissionResponse,
} from "./opencode-1-18-21-admission";
import {
  combineRootSets,
  mergedActivityStatus,
  parseActiveMap,
  parseSessionArray,
  parseV2SessionArray,
} from "./opencode-1-18-21-sessions";

interface NativeEnvelope {
  readonly data?: unknown;
  readonly error?: unknown;
}

interface V2ClientSurface {
  readonly global: { health(): Promise<unknown> };
  readonly v2: {
    readonly session: {
      active(): Promise<unknown>;
      list(parameters: {
        readonly directory: string;
        readonly limit: number;
        readonly order: "desc";
      }): Promise<unknown>;
      prompt(
        parameters: {
          readonly sessionID: string;
          readonly id: string;
          readonly prompt: { readonly text: string };
          readonly delivery: "queue" | "steer";
          readonly resume: true;
        },
        options: { readonly signal: AbortSignal },
      ): Promise<unknown>;
    };
  };
}

interface LegacyClientSurface {
  listRoots(parameters: {
    readonly roots: true;
    readonly archived: boolean;
    readonly directory: string;
  }): Promise<unknown>;
  readStatus(parameters: { readonly directory: string }): Promise<unknown>;
}

export interface OpenCodeNativeAdapterDependencies {
  readonly createV2Client?: (input: {
    readonly baseUrl: string;
    readonly directory: string;
  }) => V2ClientSurface;
  readonly now?: () => number;
}

export interface OpenCodeNativeAdapterInput {
  readonly client: unknown;
  readonly directory: string;
  readonly serverUrl: URL;
  readonly workspaceKey: WorkspaceKey;
}

export type OpenCodeNativeAdapter = HostHealthPort &
  VisibleRootSessionPort &
  NativeQueueAdmissionPort &
  NativeSteerAdmissionPort &
  CurrentWorkspaceMembershipPort;

class NativeAdapterFault extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "NativeAdapterFault";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelopeData(value: unknown, label: string): unknown {
  if (!isRecord(value)) throw new NativeAdapterFault(`${label} returned no response envelope.`);
  const envelope: NativeEnvelope = value;
  if (envelope.error !== undefined)
    throw new NativeAdapterFault(`${label} failed.`, envelope.error);
  if (!("data" in envelope)) throw new NativeAdapterFault(`${label} returned no data.`);
  return envelope.data;
}

function method(
  object: unknown,
  key: string,
  label: string,
): (...arguments_: unknown[]) => unknown {
  if (!isRecord(object)) throw new NativeAdapterFault(`${label} is unavailable.`);
  const candidate = object[key];
  if (typeof candidate !== "function") throw new NativeAdapterFault(`${label} is unavailable.`);
  return (...arguments_: unknown[]): unknown => Reflect.apply(candidate, object, arguments_);
}

function legacySurface(client: unknown): LegacyClientSurface {
  if (!isRecord(client)) throw new NativeAdapterFault("Injected legacy client is unavailable.");
  const session = client.session;
  const experimental = isRecord(client.experimental) ? client.experimental.session : undefined;
  const list = method(experimental, "list", "Legacy root/archive listing");
  const status = method(session, "status", "Legacy session status");
  return {
    async listRoots(parameters): Promise<unknown> {
      return list(parameters);
    },
    async readStatus(parameters): Promise<unknown> {
      return status(parameters);
    },
  };
}

export function createOpenCode11821NativeAdapter(
  input: OpenCodeNativeAdapterInput,
  dependencies: OpenCodeNativeAdapterDependencies = {},
): OpenCodeNativeAdapter {
  const createV2 =
    dependencies.createV2Client ?? ((configuration) => createOpencodeClient(configuration));
  const v2 = createV2({ baseUrl: input.serverUrl.toString(), directory: input.directory });
  const legacy = legacySurface(input.client);
  const now = dependencies.now ?? Date.now;
  const configuredWorkspace = validateWorkspaceKey(input.workspaceKey);
  if (!configuredWorkspace.ok) throw new NativeAdapterFault(configuredWorkspace.message);

  return {
    async readHealth(): Promise<unknown> {
      return envelopeData(await v2.global.health(), "Host health");
    },
    async readVisibleRoots(includeArchived: boolean): Promise<readonly RootSessionObservation[]> {
      const archivedRequest = includeArchived
        ? legacy.listRoots({ roots: true, archived: true, directory: input.directory })
        : undefined;
      const [listedResult, visibleRootsResult, archivedRootsResult, statusResult, activeResult] =
        await Promise.all([
          v2.v2.session.list({ directory: input.directory, limit: 100, order: "desc" }),
          legacy.listRoots({
            roots: true,
            archived: false,
            directory: input.directory,
          }),
          archivedRequest,
          legacy.readStatus({ directory: input.directory }),
          v2.v2.session.active(),
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
      const statusData = envelopeData(statusResult, "Legacy status");
      if (!isRecord(statusData)) throw new NativeAdapterFault("Legacy status map is malformed.");
      const activeData = parseActiveMap(activeResult);
      const listedById = new Map(listed.map((session) => [session.id, session]));
      const observedAtMs = now();
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
      const suppliedWorkspace = validateWorkspaceKey(workspaceKey);
      if (!suppliedWorkspace.ok || suppliedWorkspace.value !== configuredWorkspace.value) {
        throw new NativeAdapterFault("Workspace binding does not match this native adapter.");
      }
      const roots = parseSessionArray(
        envelopeData(
          await legacy.listRoots({
            roots: true,
            archived: false,
            directory: input.directory,
          }),
          "Legacy current root listing",
        ),
        "Current root listing",
      );
      const byId = new Map(roots.map((root) => [root.id, root]));
      return {
        sourceVisible: byId.has(sourceSessionId),
        targetVisible: byId.has(targetSessionId),
        sourceTitle: byId.get(sourceSessionId)?.title,
      };
    },
    async queueMessage(message) {
      if (message.abort.aborted) return { kind: "unknown" };
      let response: unknown;
      try {
        response = await v2.v2.session.prompt(
          {
            sessionID: message.targetSessionId,
            id: message.nativeMessageId,
            prompt: { text: message.envelope },
            delivery: "queue",
            resume: true,
          },
          { signal: message.abort },
        );
      } catch (_cause: unknown) {
        return { kind: "unknown" };
      }
      if (isAuthoritativeClientRejection(response, message.abort.aborted)) {
        return { kind: "definitive_rejection" };
      }
      return parseAdmissionResponse(response, message, now);
    },
    async steerRequest(request) {
      if (request.abort.aborted) return { kind: "unknown" };
      let response: unknown;
      try {
        response = await v2.v2.session.prompt(
          {
            sessionID: request.targetSessionId,
            id: request.nativeMessageId,
            prompt: { text: request.envelope },
            delivery: "steer",
            resume: true,
          },
          { signal: request.abort },
        );
      } catch (_cause: unknown) {
        return { kind: "unknown" };
      }
      if (isAuthoritativeClientRejection(response, request.abort.aborted)) {
        return { kind: "definitive_rejection" };
      }
      return parseAdmissionResponse(response, request, now, "steer");
    },
  };
}
