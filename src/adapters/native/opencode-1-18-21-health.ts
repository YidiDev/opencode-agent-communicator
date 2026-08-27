import type { PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { HostHealthPort } from "../../domain/host";

interface PinnedHealthClient {
  readonly global: { health(): Promise<unknown> };
}

export interface OpenCode11821HealthDependencies {
  readonly createClient?: (configuration: { readonly baseUrl: string }) => PinnedHealthClient;
}

/** Minimal pinned startup proof. Constructing the client performs no host request. */
export function createOpenCode11821HealthPort(
  input: PluginInput,
  dependencies: OpenCode11821HealthDependencies = {},
): HostHealthPort {
  // PluginInput.client is the pinned legacy generated surface and does not declare global health.
  // Use only the missing pinned endpoint from the same package's generated V2 client.
  const createClient = dependencies.createClient ?? createOpencodeClient;
  const pinnedClient = createClient({
    baseUrl: input.serverUrl.toString(),
  });
  return Object.freeze({
    async readHealth(): Promise<unknown> {
      const response: unknown = await pinnedClient.global.health();
      if (typeof response !== "object" || response === null || Array.isArray(response))
        return response;
      const data: unknown = Reflect.get(response, "data");
      if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
      return Object.freeze({
        healthy: Reflect.get(data, "healthy"),
        version: Reflect.get(data, "version"),
      });
    },
  });
}
