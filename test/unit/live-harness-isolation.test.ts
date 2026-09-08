import { expect, test } from "bun:test";
import { access } from "node:fs/promises";

import { createIsolatedOpenCodeState } from "../live/harness/isolation";

test("isolated setup prevents OpenCode bootstrap dependency installs from reaching the network", async () => {
  const isolation = await createIsolatedOpenCodeState({
    providerBaseUrl: "http://127.0.0.1:1/v1",
    pluginPath: "/unused/diagnostic-plugin.ts",
  });

  try {
    expect(isolation.environment.npm_config_offline).toBe("true");
  } finally {
    await isolation.remove();
  }
});

test("isolated setup recursively removes its root and preserves the injected failure", async () => {
  const failure = new Error("injected setup failure after private directories");
  let createdRoot: string | undefined;

  await expect(
    createIsolatedOpenCodeState({
      providerBaseUrl: "http://127.0.0.1:1/v1",
      pluginPath: "/unused/diagnostic-plugin.ts",
      setupOperation({ stage, root }) {
        createdRoot = root;
        if (stage === "after-directories") throw failure;
      },
    }),
  ).rejects.toBe(failure);

  if (createdRoot === undefined)
    throw new Error("fault injection did not observe the temporary root");
  await expect(access(createdRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
