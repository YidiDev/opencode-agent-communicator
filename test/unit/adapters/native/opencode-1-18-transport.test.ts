import { describe, expect, test } from "bun:test";
import { NativeAdapterFault } from "../../../../src/adapters/native/opencode-1-18-surface";
import { createBoundedOpenCode118Fetch } from "../../../../src/adapters/native/opencode-1-18-transport";

const requestUrl = "http://127.0.0.1:4321/session/secret-session/message";

function streamingResponse(
  chunks: readonly unknown[],
  options: {
    readonly headers?: HeadersInit;
    readonly shouldClose?: boolean;
    readonly status?: number;
    readonly statusText?: string;
  } = {},
): { readonly response: Response; readonly cancellations: () => number } {
  let cancellations = 0;
  const body = new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (options.shouldClose) controller.close();
    },
    cancel() {
      cancellations += 1;
    },
  });
  const { shouldClose: _shouldClose, ...responseInit } = options;
  return {
    response: new Response(body as ReadableStream<Uint8Array>, responseInit),
    cancellations: () => cancellations,
  };
}

function hostFetch(response: Response): typeof globalThis.fetch {
  return (async () => response) as unknown as typeof globalThis.fetch;
}

describe("bounded OpenCode 1.18 transport", () => {
  test("accepts the exact byte ceiling across multiple chunks and preserves response metadata", async () => {
    const fixture = streamingResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])], {
      status: 202,
      statusText: "Accepted safely",
      headers: { "content-type": "application/octet-stream", "x-native": "preserved" },
      shouldClose: true,
    });

    const response = await createBoundedOpenCode118Fetch(
      hostFetch(fixture.response),
      4,
    )(requestUrl);

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Accepted safely");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-native")).toBe("preserved");
    expect(fixture.cancellations()).toBe(0);
  });

  test("reports measured response bytes to the invocation meter", async () => {
    const observed: number[] = [];
    const fixture = streamingResponse([new Uint8Array(2), new Uint8Array(3)], {
      shouldClose: true,
    });
    await createBoundedOpenCode118Fetch(hostFetch(fixture.response), 5, (bytes) => {
      observed.push(bytes);
    })(requestUrl);
    expect(observed).toEqual([5]);
  });

  test.each([
    ["one chunk", [new Uint8Array(5)]],
    ["many chunks", [new Uint8Array(2), new Uint8Array(2), new Uint8Array(1)]],
  ])("rejects ceiling plus one in %s and cancels the source", async (_label, chunks) => {
    const fixture = streamingResponse(chunks);
    const boundedFetch = createBoundedOpenCode118Fetch(hostFetch(fixture.response), 4);

    await expect(boundedFetch(requestUrl)).rejects.toThrow(
      "Pinned OpenCode response exceeded its byte ceiling.",
    );
    expect(fixture.cancellations()).toBe(1);
  });

  test("measures bytes instead of trusting a forged Content-Length", async () => {
    const fixture = streamingResponse([new Uint8Array(3)], {
      headers: { "content-length": "1" },
    });

    await expect(
      createBoundedOpenCode118Fetch(hostFetch(fixture.response), 2)(requestUrl),
    ).rejects.toThrow("Pinned OpenCode response exceeded its byte ceiling.");
    expect(fixture.cancellations()).toBe(1);
  });

  test("bounds non-success response bodies", async () => {
    const fixture = streamingResponse([new Uint8Array(2)], { status: 500 });

    await expect(
      createBoundedOpenCode118Fetch(hostFetch(fixture.response), 1)(requestUrl),
    ).rejects.toThrow("Pinned OpenCode response exceeded its byte ceiling.");
    expect(fixture.cancellations()).toBe(1);
  });

  test("rejects an already aborted request before delegating", async () => {
    const controller = new AbortController();
    controller.abort();
    let delegations = 0;
    const boundedFetch = createBoundedOpenCode118Fetch(
      (async () => {
        delegations += 1;
        return new Response("not read");
      }) as unknown as typeof globalThis.fetch,
      32,
    );

    await expect(boundedFetch(requestUrl, { signal: controller.signal })).rejects.toThrow(
      "Pinned OpenCode response read was aborted.",
    );
    expect(delegations).toBe(0);
  });

  test("cancels a pending body read when the request is aborted", async () => {
    const controller = new AbortController();
    let cancellations = 0;
    let notifyReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          notifyReadStarted?.();
        },
        cancel() {
          cancellations += 1;
        },
      }),
    );
    const pending = createBoundedOpenCode118Fetch(hostFetch(response), 32)(requestUrl, {
      signal: controller.signal,
    });

    await readStarted;
    controller.abort();

    await expect(pending).rejects.toThrow("Pinned OpenCode response read was aborted.");
    expect(cancellations).toBe(1);
  });

  test("does not wait for an uncooperative source cancellation after aborting a stalled body", async () => {
    const controller = new AbortController();
    let cancellationStarted = false;
    let notifyReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          notifyReadStarted?.();
        },
        cancel() {
          cancellationStarted = true;
          return new Promise(() => {});
        },
      }),
    );
    const pending = createBoundedOpenCode118Fetch(hostFetch(response), 32)(requestUrl, {
      signal: controller.signal,
    });

    await readStarted;
    controller.abort();

    await expect(pending).rejects.toThrow("Pinned OpenCode response read was aborted.");
    expect(cancellationStarted).toBe(true);
  });

  test("fails closed when an expected body is absent but permits bodyless HEAD responses", async () => {
    await expect(
      createBoundedOpenCode118Fetch(hostFetch(new Response(null)), 0)(requestUrl),
    ).rejects.toThrow("Pinned OpenCode response body is unreadable.");

    const response = await createBoundedOpenCode118Fetch(hostFetch(new Response(null)), 0)(
      requestUrl,
      { method: "HEAD" },
    );
    expect(response.body).toBeNull();
    expect(response.status).toBe(200);
  });

  test("rejects malformed non-byte chunks and cancels the source", async () => {
    const fixture = streamingResponse(["private response payload"]);

    await expect(
      createBoundedOpenCode118Fetch(hostFetch(fixture.response), 1024)(requestUrl),
    ).rejects.toThrow("Pinned OpenCode response body is unreadable.");
    expect(fixture.cancellations()).toBe(1);
  });

  test("uses payload-free NativeAdapterFault messages for transport and body failures", async () => {
    const transportFailure = createBoundedOpenCode118Fetch(
      (async () => {
        throw new Error(`failed for ${requestUrl}`);
      }) as unknown as typeof globalThis.fetch,
      8,
    );
    const malformedFixture = streamingResponse([requestUrl]);

    for (const operation of [
      transportFailure(requestUrl),
      createBoundedOpenCode118Fetch(hostFetch(malformedFixture.response), 8)(requestUrl),
    ]) {
      try {
        await operation;
        throw new Error("expected transport operation to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(NativeAdapterFault);
        expect(error instanceof Error ? error.message : "").not.toContain("secret-session");
        expect(error instanceof Error ? error.message : "").not.toContain(requestUrl);
        expect(error instanceof Error ? error.cause : undefined).toBeUndefined();
      }
    }
  });

  test.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects an invalid byte ceiling of %p",
    (maximumResponseBytes) => {
      expect(() =>
        createBoundedOpenCode118Fetch(hostFetch(new Response()), maximumResponseBytes),
      ).toThrow("Pinned OpenCode response byte ceiling is invalid.");
    },
  );
});
