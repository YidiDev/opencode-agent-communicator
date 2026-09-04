import { describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { createOpenCode118HealthPort } from "../../../../src/adapters/native/opencode-1-18-health";
import { readOpenCode118Transport } from "../../../../src/adapters/native/opencode-1-18-transport";

function pluginInput(
  fetchImplementation: typeof globalThis.fetch = (async () =>
    new Response(JSON.stringify({ healthy: true, version: "1.18.24" }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch,
) {
  return {
    client: {
      _client: {
        getConfig: () => ({ fetch: fetchImplementation, headers: new Headers() }),
      },
    },
    serverUrl: new URL("http://127.0.0.1:4321"),
    directory: "/workspace",
  };
}

describe("pinned startup health adapter", () => {
  test("constructs the pinned default client without making a host request", () => {
    let requests = 0;
    const port = createOpenCode118HealthPort(
      pluginInput((async () => {
        requests += 1;
        return new Response();
      }) as unknown as typeof globalThis.fetch) as never,
    );

    expect(port.readHealth).toBeFunction();
    expect(requests).toBe(0);
  });

  test("reuses the injected transport and snapshots only narrow health data", async () => {
    const calls: string[] = [];
    const inProcessFetch = (async () => new Response()) as unknown as typeof globalThis.fetch;
    const client = {
      global: {
        health: async () => {
          calls.push("pinned.global.health");
          return {
            data: { healthy: true, version: "1.18.23" },
            response: { secret: "not projected" },
          };
        },
      },
    };
    const input = pluginInput(inProcessFetch);
    input.client._client.getConfig = () => ({
      fetch: inProcessFetch,
      headers: new Headers({
        authorization: "Basic pinned",
        "x-opencode-directory": "/workspace",
        "x-opencode-workspace": "workspace-id",
      }),
    });
    const port = createOpenCode118HealthPort(input as never, {
      createClient(configuration) {
        expect(configuration.baseUrl).toBe("http://127.0.0.1:4321/");
        expect(configuration.fetch).not.toBe(inProcessFetch);
        expect(configuration.fetch).toBeFunction();
        expect(configuration.headers.authorization).toBe("Basic pinned");
        expect(configuration.headers["x-opencode-directory"]).toBeUndefined();
        expect(configuration.headers["x-opencode-workspace"]).toBeUndefined();
        calls.push("create");
        return client;
      },
    });
    expect(await port.readHealth()).toEqual({ healthy: true, version: "1.18.23" });
    expect(calls).toEqual(["create", "pinned.global.health"]);
  });

  test("reuses the pinned client after a transient health transport failure", async () => {
    let clientCreations = 0;
    let healthReads = 0;
    const port = createOpenCode118HealthPort(
      {
        ...pluginInput(),
      } as never,
      {
        createClient() {
          clientCreations += 1;
          return {
            global: {
              async health() {
                healthReads += 1;
                if (healthReads === 1) throw new Error("listener is not ready");
                return { data: { healthy: true, version: "1.18.24" } };
              },
            },
          };
        },
      },
    );

    await expect(port.readHealth()).rejects.toThrow("listener is not ready");
    expect(await port.readHealth()).toEqual({ healthy: true, version: "1.18.24" });
    expect(clientCreations).toBe(1);
    expect(healthReads).toBe(2);
  });

  test("rejects a generated error envelope without exposing its transport cause", async () => {
    const port = createOpenCode118HealthPort(pluginInput() as never, {
      createClient: () => ({
        global: {
          health: async () => ({ error: new Error("credential-bearing transport detail") }),
        },
      }),
    });

    await expect(port.readHealth()).rejects.toThrow("Pinned OpenCode health request failed.");
    try {
      await port.readHealth();
    } catch (error: unknown) {
      expect(error instanceof Error ? error.message : "").not.toContain("credential-bearing");
    }
  });

  test("preserves authentication when V2 adds directory routing", async () => {
    let request: Request | undefined;
    const inProcessFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ healthy: true, version: "1.18.24" });
    }) as unknown as typeof globalThis.fetch;
    const input = pluginInput(inProcessFetch);
    input.client._client.getConfig = () => ({
      fetch: inProcessFetch,
      headers: new Headers({ authorization: "Basic pinned" }),
    });
    const client = createOpencodeClient({
      baseUrl: input.serverUrl.toString(),
      directory: input.directory,
      ...readOpenCode118Transport(input.client),
    });

    await client.global.health();

    expect(request?.headers.get("authorization")).toBe("Basic pinned");
    expect(new URL(request?.url ?? "http://invalid").searchParams.get("directory")).toBe(
      input.directory,
    );
  });

  test("cancels a stalled health response body through the supplied operation signal", async () => {
    const controller = new AbortController();
    let cancellations = 0;
    let started: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const port = createOpenCode118HealthPort(
      pluginInput(
        (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                started?.();
              },
              cancel() {
                cancellations += 1;
              },
            }),
            { headers: { "content-type": "application/json" } },
          )) as unknown as typeof globalThis.fetch,
      ) as never,
    );

    const pending = port.readHealth(controller.signal);
    await reading;
    controller.abort("deadline");

    await expect(pending).rejects.toThrow("response read was aborted");
    expect(cancellations).toBe(1);
  });

  test("rejects an oversized health response before SDK deserialization", async () => {
    let cancellations = 0;
    const port = createOpenCode118HealthPort(
      pluginInput(
        (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(new Uint8Array(16 * 1_024 + 1));
              },
              cancel() {
                cancellations += 1;
              },
            }),
            { headers: { "content-type": "application/json" } },
          )) as unknown as typeof globalThis.fetch,
      ) as never,
    );

    await expect(port.readHealth(new AbortController().signal)).rejects.toThrow(
      "exceeded its byte ceiling",
    );
    expect(cancellations).toBe(1);
  });

  test.each([
    ["invalid client", null],
    ["missing core", {}],
    ["missing configuration reader", { _client: {} }],
    ["invalid configuration", { _client: { getConfig: () => null } }],
    ["missing fetch", { _client: { getConfig: () => ({}) } }],
  ])("fails closed for a pinned client with %s", async (_label, client) => {
    const port = createOpenCode118HealthPort({ ...pluginInput(), client } as never);
    await expect(port.readHealth()).rejects.toThrow("Pinned OpenCode transport is unavailable");
  });
});
