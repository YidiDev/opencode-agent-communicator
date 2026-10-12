import type { Plugin } from "@opencode/plugin/effect";
import type { HostHealthPort } from "../../domain/host";

export interface AbortAwareHostHealthPort extends HostHealthPort {
  readHealth(signal?: AbortSignal): Promise<unknown>;
}

/** Uses only the identity supplied by the v2 plugin host; no private health transport is opened. */
export function createOpenCode2HealthPort(
  input: Pick<Plugin.Context, "app">,
): AbortAwareHostHealthPort {
  return Object.freeze({
    async readHealth(signal?: AbortSignal): Promise<unknown> {
      if (signal?.aborted) throw signal.reason;
      return Object.freeze({ healthy: true, version: input.app.version });
    },
  });
}
