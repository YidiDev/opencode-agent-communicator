import { method, requireRecord } from "./opencode-1-18-surface";

export interface LegacyClientSurface {
  listRoots(
    parameters: { readonly roots: true; readonly directory: string },
    options?: { readonly signal?: AbortSignal; readonly fetch?: typeof globalThis.fetch },
  ): Promise<unknown>;
  readStatus(
    parameters: { readonly directory: string },
    options?: { readonly signal?: AbortSignal; readonly fetch?: typeof globalThis.fetch },
  ): Promise<unknown>;
  interrupt(
    parameters: { readonly sessionID: string; readonly directory: string },
    options: { readonly signal: AbortSignal; readonly fetch?: typeof globalThis.fetch },
  ): Promise<unknown>;
}

/** Adapts the pinned legacy generated client's single-options API without dropping call controls. */
export function legacySurface(client: unknown): LegacyClientSurface {
  const legacyClient = requireRecord(client, "Injected legacy client is unavailable.");
  const session = legacyClient.session;
  const generated = Object.getOwnPropertyDescriptor(legacyClient, "_client")?.value !== undefined;
  const status = method(session, "status", "Legacy session status");
  const abort = method(session, "abort", "Legacy session interrupt");
  return {
    async listRoots(parameters, options): Promise<unknown> {
      if (generated) {
        return method(
          session,
          "list",
          "Pinned legacy root listing",
        )({
          ...options,
          query: { roots: parameters.roots, directory: parameters.directory },
        });
      }
      return method(session, "list", "Pinned legacy root listing")(parameters, options);
    },
    async readStatus(parameters, options): Promise<unknown> {
      if (generated) return status({ ...options, query: { directory: parameters.directory } });
      return status(parameters, options);
    },
    async interrupt(parameters, options): Promise<unknown> {
      if (generated) {
        return abort({
          ...options,
          path: { id: parameters.sessionID },
          query: { directory: parameters.directory },
        });
      }
      return abort(parameters, options);
    },
  };
}
