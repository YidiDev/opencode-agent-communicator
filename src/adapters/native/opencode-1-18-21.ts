import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { HostHealthPort } from "../../domain/host";
import {
  type ActivityStatus,
  type RootSessionObservation,
  type SessionId,
  type VisibleRootSessionPort,
  validateSessionId,
} from "../../domain/sessions";

interface NativeEnvelope {
  readonly data?: unknown;
  readonly error?: unknown;
}

interface V2ClientSurface {
  readonly global: { health(): Promise<unknown> };
  readonly v2: {
    readonly session: {
      list(parameters: {
        readonly directory: string;
        readonly limit: number;
        readonly order: "desc";
      }): Promise<unknown>;
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
}

export type OpenCodeNativeAdapter = HostHealthPort & VisibleRootSessionPort;

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

interface NativeSession {
  readonly id: SessionId;
  readonly title: string;
  readonly updatedAtMs: number;
  readonly isArchived: boolean;
}

function nativeSession(value: unknown): NativeSession {
  if (!isRecord(value) || typeof value.title !== "string" || !isRecord(value.time)) {
    throw new NativeAdapterFault("Native session entry is malformed.");
  }
  const id = validateSessionId(value.id);
  const updated = value.time.updated;
  const archived = value.time.archived;
  if (!id.ok || typeof updated !== "number" || !Number.isFinite(updated)) {
    throw new NativeAdapterFault("Native session identity or update time is malformed.");
  }
  if (archived !== undefined && (typeof archived !== "number" || !Number.isFinite(archived))) {
    throw new NativeAdapterFault("Native session archive time is malformed.");
  }
  return {
    id: id.value,
    title: value.title,
    updatedAtMs: updated,
    isArchived: archived !== undefined,
  };
}

function sessionArray(value: unknown, label: string): NativeSession[] {
  if (!Array.isArray(value)) throw new NativeAdapterFault(`${label} is malformed.`);
  return value.map(nativeSession);
}

function v2SessionArray(value: unknown): NativeSession[] {
  const response = envelopeData(value, "V2 session listing");
  if (!isRecord(response)) throw new NativeAdapterFault("V2 listing is malformed.");
  return sessionArray(response.data, "V2 listing data");
}

function activityStatus(value: unknown): ActivityStatus {
  if (!isRecord(value)) return "unknown";
  if (value.type === "busy" || value.type === "idle") return value.type;
  if (
    value.type === "retry" &&
    Number.isInteger(value.attempt) &&
    typeof value.message === "string" &&
    typeof value.next === "number" &&
    Number.isFinite(value.next)
  ) {
    return "retry";
  }
  return "unknown";
}

function statusFor(statuses: Record<string, unknown>, id: SessionId): ActivityStatus {
  return id in statuses ? activityStatus(statuses[id]) : "idle";
}

function combineRootSets(
  visibleRoots: readonly NativeSession[],
  archivedRoots: readonly NativeSession[],
): NativeSession[] {
  const rootsById = new Map<SessionId, NativeSession>();
  for (const root of visibleRoots) rootsById.set(root.id, { ...root, isArchived: false });
  for (const archived of archivedRoots) {
    rootsById.set(archived.id, {
      ...archived,
      // Membership in the archived=true set is the authoritative archive evidence.
      isArchived: true,
    });
  }
  return [...rootsById.values()];
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

  return {
    async readHealth(): Promise<unknown> {
      return envelopeData(await v2.global.health(), "Host health");
    },
    async readVisibleRoots(includeArchived: boolean): Promise<readonly RootSessionObservation[]> {
      const archivedRequest = includeArchived
        ? legacy.listRoots({ roots: true, archived: true, directory: input.directory })
        : undefined;
      const [listedResult, visibleRootsResult, archivedRootsResult, statusResult] =
        await Promise.all([
          v2.v2.session.list({ directory: input.directory, limit: 100, order: "desc" }),
          legacy.listRoots({
            roots: true,
            archived: false,
            directory: input.directory,
          }),
          archivedRequest,
          legacy.readStatus({ directory: input.directory }),
        ]);
      const listed = v2SessionArray(listedResult);
      const visibleRoots = sessionArray(
        envelopeData(visibleRootsResult, "Legacy visible root listing"),
        "Visible root listing",
      );
      const archivedRoots =
        archivedRootsResult === undefined
          ? []
          : sessionArray(
              envelopeData(archivedRootsResult, "Legacy archived root listing"),
              "Archived root listing",
            );
      const roots = combineRootSets(visibleRoots, archivedRoots);
      const statusData = envelopeData(statusResult, "Legacy status");
      if (!isRecord(statusData)) throw new NativeAdapterFault("Legacy status map is malformed.");
      const listedById = new Map(listed.map((session) => [session.id, session]));
      const observedAtMs = now();
      return roots.map((root) => {
        const display = listedById.get(root.id) ?? root;
        return {
          id: root.id,
          title: display.title,
          updatedAtMs: display.updatedAtMs,
          isArchived: root.isArchived,
          status: statusFor(statusData, root.id),
          observedAtMs,
        };
      });
    },
  };
}
