import { describe, expect, test } from "bun:test";

import { createOpenCode11821HealthPort } from "../../../../src/adapters/native/opencode-1-18-21-health";

describe("pinned startup health adapter", () => {
  test("constructs the pinned default client without making a host request", () => {
    const port = createOpenCode11821HealthPort({
      serverUrl: new URL("http://127.0.0.1:4321"),
      directory: "/workspace",
    } as never);

    expect(port.readHealth).toBeFunction();
  });

  test("uses only the narrow pinned client health endpoint and snapshots only health data", async () => {
    const calls: string[] = [];
    const client = {
      global: {
        health: async () => {
          calls.push("pinned.global.health");
          return {
            data: { healthy: true, version: "1.18.21" },
            response: { secret: "not projected" },
          };
        },
      },
    };
    const input = {
      client: Object.freeze({ untouched: true }),
      serverUrl: new URL("http://127.0.0.1:4321"),
      directory: "/workspace",
    } as never;
    const port = createOpenCode11821HealthPort(input, {
      createClient(configuration) {
        expect(configuration).toEqual({ baseUrl: "http://127.0.0.1:4321/" });
        calls.push("create");
        return client;
      },
    });
    expect(await port.readHealth()).toEqual({ healthy: true, version: "1.18.21" });
    expect(calls).toEqual(["create", "pinned.global.health"]);
  });
});
