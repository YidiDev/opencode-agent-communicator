import { NativeAdapterFault } from "./opencode-1-18-surface";

export interface OpenCode118Transport {
  readonly fetch: typeof globalThis.fetch;
  readonly headers: Readonly<Record<string, string>>;
}

const ABORTED_MESSAGE = "Pinned OpenCode response read was aborted.";
const MALFORMED_BODY_MESSAGE = "Pinned OpenCode response body is unreadable.";
const OVERSIZED_BODY_MESSAGE = "Pinned OpenCode response exceeded its byte ceiling.";

function requestAbortSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init && "signal" in init) return init.signal ?? undefined;
  return input instanceof Request ? input.signal : undefined;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method;
  return input instanceof Request ? input.method : "GET";
}

function responseCanOmitBody(method: string, status: number): boolean {
  return (
    method.toUpperCase() === "HEAD" ||
    (status >= 100 && status < 200) ||
    status === 204 ||
    status === 205 ||
    status === 304
  );
}

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  cancelReader: () => Promise<void>,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  let result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
  try {
    result = await reader.read();
  } catch (_cause: unknown) {
    await cancelReader();
    if (signal?.aborted) throw new NativeAdapterFault(ABORTED_MESSAGE);
    throw new NativeAdapterFault(MALFORMED_BODY_MESSAGE);
  }
  if (signal?.aborted) {
    await cancelReader();
    throw new NativeAdapterFault(ABORTED_MESSAGE);
  }
  return result;
}

async function readBoundedBody(
  response: Response,
  method: string,
  maximumResponseBytes: number,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer | null> {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch (_cause: unknown) {
    throw new NativeAdapterFault(MALFORMED_BODY_MESSAGE);
  }
  if (body === null) {
    if (responseCanOmitBody(method, response.status)) return null;
    throw new NativeAdapterFault(MALFORMED_BODY_MESSAGE);
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch (_cause: unknown) {
    throw new NativeAdapterFault(MALFORMED_BODY_MESSAGE);
  }

  let didCancel = false;
  let cancellation: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    if (cancellation) return cancellation;
    didCancel = true;
    cancellation = Promise.resolve()
      .then(() => reader.cancel())
      .then(
        () => undefined,
        () => undefined,
      );
    return cancellation;
  };
  const abortReader = (): void => {
    void cancelReader();
  };
  signal?.addEventListener("abort", abortReader, { once: true });

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    if (signal?.aborted) {
      await cancelReader();
      throw new NativeAdapterFault(ABORTED_MESSAGE);
    }
    while (true) {
      const result = await readNextChunk(reader, signal, cancelReader);
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        await cancelReader();
        throw new NativeAdapterFault(MALFORMED_BODY_MESSAGE);
      }
      if (result.value.byteLength > maximumResponseBytes - byteLength) {
        await cancelReader();
        throw new NativeAdapterFault(OVERSIZED_BODY_MESSAGE);
      }
      byteLength += result.value.byteLength;
      chunks.push(result.value);
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
    if (!didCancel) reader.releaseLock();
  }

  const boundedBody = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    boundedBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return boundedBody.buffer;
}

/** Bounds every response body from a host-selected transport without trusting response metadata. */
export function createBoundedOpenCode118Fetch(
  fetchImplementation: typeof globalThis.fetch,
  maximumResponseBytes: number,
  observeResponseBytes: (byteLength: number) => void = () => undefined,
): typeof globalThis.fetch {
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 0) {
    throw new NativeAdapterFault("Pinned OpenCode response byte ceiling is invalid.");
  }

  const boundedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = requestAbortSignal(input, init);
    if (signal?.aborted) throw new NativeAdapterFault(ABORTED_MESSAGE);

    let response: Response;
    try {
      response = await fetchImplementation(input, init);
    } catch (_cause: unknown) {
      if (signal?.aborted) throw new NativeAdapterFault(ABORTED_MESSAGE);
      throw new NativeAdapterFault("Pinned OpenCode transport request failed.");
    }
    if (!(response instanceof Response)) {
      throw new NativeAdapterFault("Pinned OpenCode transport returned malformed data.");
    }

    const body = await readBoundedBody(
      response,
      requestMethod(input, init),
      maximumResponseBytes,
      signal,
    );
    observeResponseBytes(body?.byteLength ?? 0);
    try {
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (_cause: unknown) {
      throw new NativeAdapterFault("Pinned OpenCode transport returned malformed data.");
    }
  };
  return Object.assign(boundedFetch, {
    preconnect(
      url: string | URL,
      options?: Parameters<typeof globalThis.fetch.preconnect>[1],
    ): void {
      const implementation: unknown = fetchImplementation.preconnect;
      if (typeof implementation === "function") {
        Reflect.apply(implementation, fetchImplementation, [url, options]);
      }
    },
  });
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
