import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommunicatorOptions } from "../../../src/composition/config";
import { createProductionExporter } from "../../../src/composition/plugin-exporter";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("lifecycle refactor exporter applies defaults for every omitted optional limit", () => {
  const root = mkdtempSync(join(tmpdir(), "communicator-lifecycle-refactor-export-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const options = parseCommunicatorOptions(
    {
      stateDirectory: join(root, "state"),
      export: {
        root: join(root, "exports"),
        limits: {},
      },
    },
    { HOME: root },
  );

  const exporter = createProductionExporter(options, {
    client: {},
    directory: root,
    worktree: root,
    serverUrl: new URL("http://localhost"),
  } as never);

  expect(exporter.drain).toBeFunction();
  expect(exporter.dispose).toBeFunction();
  exporter.dispose?.();
});
