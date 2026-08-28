import type { PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { HostHealthPort } from "../../domain/host";
import { readOpenCode118Transport } from "./opencode-1-18-transport";

interface PinnedHealthClient {
  readonly global: { health(): Promise<unknown> };
}

export interface OpenCode118HealthDependencies {
  readonly createClient?: (configuration: {
    readonly baseUrl: string;
    readonly fetch: typeof globalThis.fetch;
    readonly headers: Readonly<Record<string, string>>;
  }) => PinnedHealthClient;
}

/** Minimal pinned startup proof. Constructing the client performs no host request. */
export function createOpenCode118HealthPort(
  input: PluginInput,
  dependencies: OpenCode118HealthDependencies = {},
): HostHealthPort {
  const createClient = dependencies.createClient ?? createOpencodeClient;
  let pinnedClient: PinnedHealthClient | undefined;
  return Object.freeze({
    async readHealth(): Promise<unknown> {
      // The legacy surface omits health, but carries OpenCode's network or in-process transport.
      pinnedClient ??= createClient({
        baseUrl: input.serverUrl.toString(),
        ...readOpenCode118Transport(input.client),
      });
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
