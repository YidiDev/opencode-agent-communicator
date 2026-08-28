import { NativeAdapterFault } from "./opencode-1-18-surface";

export interface OpenCode118Transport {
  readonly fetch: typeof globalThis.fetch;
  readonly headers: Readonly<Record<string, string>>;
}

/** Reuses the host-selected network or in-process transport from the pinned legacy client. */
export function readOpenCode118Transport(client: unknown): OpenCode118Transport {
  try {
    if (typeof client !== "object" || client === null || Array.isArray(client)) throw new Error();
    const core = Object.getOwnPropertyDescriptor(client, "_client")?.value;
    if (typeof core !== "object" || core === null || Array.isArray(core)) throw new Error();
    const getConfig = Object.getOwnPropertyDescriptor(core, "getConfig")?.value;
    if (typeof getConfig !== "function") throw new Error();
    const config: unknown = Reflect.apply(getConfig, core, []);
    if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error();
    const fetchImplementation = Object.getOwnPropertyDescriptor(config, "fetch")?.value;
    if (typeof fetchImplementation !== "function") throw new Error();
    const headersValue = Object.getOwnPropertyDescriptor(config, "headers")?.value;
    const headers = new Headers(headersValue as HeadersInit | undefined);
    headers.delete("x-opencode-directory");
    headers.delete("x-opencode-workspace");
    return Object.freeze({
      fetch: fetchImplementation as typeof globalThis.fetch,
      headers: Object.freeze(Object.fromEntries(headers)),
    });
  } catch (cause: unknown) {
    throw new NativeAdapterFault("Pinned OpenCode transport is unavailable.", cause);
  }
}
