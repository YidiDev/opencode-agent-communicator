import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  CurrentWorkspaceMembershipPort,
  NativeQueueAdmissionPort,
} from "../../application/delivery-ports";
import type { NativeParticipantPresencePort } from "../../application/participant-deletion-ports";
import type {
  NativeSteerAdmissionPort,
  RequestParticipantActivityPort,
} from "../../application/request-ports";
import type { NativeSessionStartPort } from "../../application/session-start-ports";
import type { NativeSessionInterruptPort } from "../../application/session-stop-ports";
import type { HostHealthPort } from "../../domain/host";
import { type VisibleRootSessionPort, validateSessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import { validateWorkspaceKey } from "../../domain/workspaces";
import { createAdmissionOperations, createObservationOperations } from "./opencode-1-18-operations";
import { createDirectParticipantPresencePort } from "./opencode-1-18-presence";
import { admitPublicMessage, type PublicMessageSurface } from "./opencode-1-18-public-message";
import {
  admitLegacyInitialMessage,
  createDeterministicRootSession,
  reconcileDeterministicRootSession,
  updateAndVerifySessionTitle,
} from "./opencode-1-18-start";
import { envelopeData, method, NativeAdapterFault, requireRecord } from "./opencode-1-18-surface";
import { readOpenCode118Transport } from "./opencode-1-18-transport";

interface V2ClientSurface {
  readonly global: { health(): Promise<unknown> };
  readonly experimental?: {
    readonly session: {
      list(
        parameters: {
          readonly roots: true;
          readonly archived: boolean;
          readonly directory: string;
        },
        options?: { readonly signal?: AbortSignal },
      ): Promise<unknown>;
    };
  };
  readonly session?: Pick<PublicMessageSurface, "promptAsync" | "message"> & {
    update(
      parameters: {
        readonly sessionID: string;
        readonly directory: string;
        readonly title: string;
      },
      options: { readonly signal: AbortSignal },
    ): Promise<unknown>;
  };
  readonly v2: {
    readonly session: {
      active(options?: { readonly signal?: AbortSignal }): Promise<unknown>;
      create?(
        parameters: {
          readonly id: string;
          readonly agent?: string;
          readonly model?: { readonly providerID: string; readonly id: string };
          readonly location: { readonly directory: string };
        },
        options: { readonly signal: AbortSignal },
      ): Promise<unknown>;
      get?(
        parameters: { readonly sessionID: string },
        options: { readonly signal: AbortSignal },
      ): Promise<unknown>;
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
  listRoots(
    parameters: { readonly roots: true; readonly directory: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
  readStatus(
    parameters: { readonly directory: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
  interrupt(
    parameters: { readonly sessionID: string; readonly directory: string },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
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
  RequestParticipantActivityPort &
  CurrentWorkspaceMembershipPort &
  NativeSessionInterruptPort &
  NativeSessionStartPort &
  NativeParticipantPresencePort;

function legacySurface(client: unknown): LegacyClientSurface {
  const legacyClient = requireRecord(client, "Injected legacy client is unavailable.");
  const session = legacyClient.session;
  // Supported 1.18 runtimes expose this endpoint although the legacy generated type omits it.
  const status = method(session, "status", "Legacy session status");
  const abort = method(session, "abort", "Legacy session interrupt");
  return {
    async listRoots(parameters, options): Promise<unknown> {
      return method(session, "list", "Pinned legacy root listing")(parameters, options);
    },
    async readStatus(parameters, options): Promise<unknown> {
      return status(parameters, options);
    },
    async interrupt(parameters, options): Promise<unknown> {
      return abort(parameters, options);
    },
  };
}

function startSessionSurface(session: V2ClientSurface["v2"]["session"]) {
  return {
    async create(
      parameters: {
        readonly id: string;
        readonly agent?: string;
        readonly model?: { readonly providerID: string; readonly id: string };
        readonly location: { readonly directory: string };
      },
      options: { readonly signal: AbortSignal },
    ) {
      if (!session.create) throw new NativeAdapterFault("V2 session creation is unavailable.");
      return session.create(parameters, options);
    },
    async get(
      parameters: { readonly sessionID: string },
      options: { readonly signal: AbortSignal },
    ) {
      if (!session.get) throw new NativeAdapterFault("V2 session read-back is unavailable.");
      return session.get(parameters, options);
    },
  };
}

export function createOpenCode118NativeAdapter(
  input: OpenCodeNativeAdapterInput,
  dependencies: OpenCodeNativeAdapterDependencies = {},
): OpenCodeNativeAdapter {
  const configuration = { baseUrl: input.serverUrl.toString(), directory: input.directory };
  const v2 = dependencies.createV2Client
    ? dependencies.createV2Client(configuration)
    : createOpencodeClient({ ...configuration, ...readOpenCode118Transport(input.client) });
  const legacy = legacySurface(input.client);
  const listArchivedRoots = (
    parameters: { readonly roots: true; readonly archived: boolean; readonly directory: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown> =>
    method(
      v2.experimental?.session,
      "list",
      "Pinned root/archive listing",
    )(parameters, options) as Promise<unknown>;
  const startSession = startSessionSurface(v2.v2.session);
  const publicStartSession = {
    updateTitle: async (
      parameters: {
        readonly sessionID: string;
        readonly directory: string;
        readonly title: string;
      },
      options: { readonly signal: AbortSignal },
    ) => method(v2.session, "update", "Public session title update")(parameters, options),
    promptAsync: async (
      parameters: {
        readonly sessionID: string;
        readonly directory: string;
        readonly messageID: string;
        readonly model?: { readonly providerID: string; readonly modelID: string };
        readonly agent?: string;
        readonly parts: [{ readonly type: "text"; readonly text: string }];
      },
      options: { readonly signal: AbortSignal },
    ) =>
      method(v2.session, "promptAsync", "Public asynchronous session prompt")(parameters, options),
    message: async (
      parameters: {
        readonly sessionID: string;
        readonly directory: string;
        readonly messageID: string;
      },
      options: { readonly signal: AbortSignal },
    ) => method(v2.session, "message", "Public session message read-back")(parameters, options),
  };
  const participantPresence = createDirectParticipantPresencePort(startSession);
  const now = dependencies.now ?? Date.now;
  const configuredWorkspace = validateWorkspaceKey(input.workspaceKey);
  if (!configuredWorkspace.ok) throw new NativeAdapterFault(configuredWorkspace.message);
  const observations = createObservationOperations({
    active: (options) => v2.v2.session.active(options),
    configuredWorkspace: configuredWorkspace.value,
    health: () => v2.global.health(),
    listArchivedRoots: () =>
      listArchivedRoots({ roots: true, archived: true, directory: input.directory }),
    listMetadata: () =>
      v2.v2.session.list({ directory: input.directory, limit: 100, order: "desc" }),
    listVisibleRoots: (options) =>
      legacy.listRoots({ roots: true, directory: input.directory }, options),
    now,
    readStatus: (options) => legacy.readStatus({ directory: input.directory }, options),
  });
  const admissions = createAdmissionOperations({
    now,
    prompt: (parameters, options) => v2.v2.session.prompt(parameters, options),
  });

  return {
    ...observations,
    ...admissions,
    ...participantPresence,
    async queueMessage(request) {
      const result = await admitPublicMessage(
        publicStartSession,
        input.directory,
        {
          sessionId: request.targetSessionId,
          nativeMessageId: request.nativeMessageId,
          text: request.envelope,
          abort: request.abort,
        },
        { now },
      );
      return result.kind === "observed"
        ? { kind: "public_message", observedAtMs: result.observedAtMs }
        : result;
    },
    async interruptSession(request) {
      if (request.abort.aborted || !validateSessionId(request.targetSessionId).ok) {
        return "unknown";
      }
      try {
        const response = await legacy.interrupt(
          { sessionID: request.targetSessionId, directory: input.directory },
          { signal: request.abort },
        );
        if (request.abort.aborted) return "unknown";
        return envelopeData(response, "Legacy session interrupt") === true
          ? "interrupted"
          : "unknown";
      } catch {
        return "unknown";
      }
    },
    async createRootSession(request) {
      return createDeterministicRootSession(startSession, input.directory, request);
    },
    async reconcileRootSession(request) {
      return reconcileDeterministicRootSession(startSession, input.directory, request);
    },
    async updateSessionTitle(request) {
      return updateAndVerifySessionTitle(publicStartSession, input.directory, request);
    },
    async admitInitialMessage(request) {
      return admitLegacyInitialMessage(publicStartSession, input.directory, request);
    },
  };
}
