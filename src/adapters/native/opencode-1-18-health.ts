import type { PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { HostHealthPort } from "../../domain/host";
import { NativeAdapterFault } from "./opencode-1-18-surface";
import {
  createBoundedOpenCode118Fetch,
  openCode118ResponseByteCeilings,
  readOpenCode118Transport,
} from "./opencode-1-18-transport";

interface PinnedHealthClient {
  readonly global: { health(options?: { readonly signal?: AbortSignal }): Promise<unknown> };
}

export interface OpenCode118HealthDependencies {
  readonly createClient?: (configuration: {
    readonly baseUrl: string;
    readonly fetch: typeof globalThis.fetch;
    readonly headers: Readonly<Record<string, string>>;
  }) => PinnedHealthClient;
}

export interface AbortAwareHostHealthPort extends HostHealthPort {
  readHealth(signal?: AbortSignal): Promise<unknown>;
}

/** Minimal pinned startup proof. Constructing the client performs no host request. */
export function createOpenCode118HealthPort(
  input: PluginInput,
  dependencies: OpenCode118HealthDependencies = {},
): AbortAwareHostHealthPort {
  const createClient = dependencies.createClient ?? createOpencodeClient;
  let pinnedClient: PinnedHealthClient | undefined;
  return Object.freeze({
    async readHealth(signal?: AbortSignal): Promise<unknown> {
      // The legacy surface omits health, but carries OpenCode's network or in-process transport.
      if (!pinnedClient) {
        const transport = readOpenCode118Transport(input.client);
        pinnedClient = createClient({
          baseUrl: input.serverUrl.toString(),
          ...transport,
          fetch: createBoundedOpenCode118Fetch(
            transport.fetch,
            openCode118ResponseByteCeilings.health,
          ),
        });
      }
      const response: unknown = await pinnedClient.global.health(signal ? { signal } : undefined);
      if (typeof response !== "object" || response === null || Array.isArray(response))
        return response;
      const error: unknown = Reflect.get(response, "error");
      if (error instanceof NativeAdapterFault) throw error;
      if (error !== undefined)
        throw new NativeAdapterFault("Pinned OpenCode health request failed.");
      const data: unknown = Reflect.get(response, "data");
      if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
      return Object.freeze({
        healthy: Reflect.get(data, "healthy"),
        version: Reflect.get(data, "version"),
      });
    },
  });
}
