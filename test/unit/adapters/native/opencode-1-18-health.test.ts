import { describe, expect, test } from "bun:test";

import { createOpenCode118HealthPort } from "../../../../src/adapters/native/opencode-1-18-health";

describe("pinned startup health adapter", () => {
  test("constructs the pinned default client without making a host request", () => {
    const port = createOpenCode118HealthPort({
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
            data: { healthy: true, version: "1.18.23" },
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
    const port = createOpenCode118HealthPort(input, {
      createClient(configuration) {
        expect(configuration).toEqual({ baseUrl: "http://127.0.0.1:4321/" });
        calls.push("create");
        return client;
      },
    });
    expect(await port.readHealth()).toEqual({ healthy: true, version: "1.18.23" });
    expect(calls).toEqual(["create", "pinned.global.health"]);
  });
});
