import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  exposeDeclaredRuntimeDependencies,
  packedRuntimeDependenciesRootEnvironmentVariable,
  resolvePackedRuntimeDependenciesRoot,
} from "../live/harness/packed-plugin";

async function writeDependency(root: string, name: string, version: string): Promise<string> {
  const directory = join(root, ...name.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
  return directory;
}

interface Fixture {
  readonly consumerNodeModules: string;
  readonly repository: string;
  readonly runtimeDependenciesRoot: string;
  readonly root: string;
}

async function withFixture(operation: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "packed-runtime-dependencies-"));
  const repository = join(root, "repository");
  try {
    await operation({
      consumerNodeModules: join(root, "consumer/node_modules"),
      repository,
      runtimeDependenciesRoot: join(repository, "node_modules"),
      root,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("exposes a verified exact runtime dependency from repository node_modules", async () => {
  await withFixture(async ({ consumerNodeModules, runtimeDependenciesRoot }) => {
    const source = await writeDependency(runtimeDependenciesRoot, "@example/runtime", "1.2.3");

    await exposeDeclaredRuntimeDependencies({
      consumerNodeModules,
      dependencies: { "@example/runtime": "1.2.3" },
      runtimeDependenciesRoot,
    });

    expect(await realpath(join(consumerNodeModules, "@example/runtime"))).toBe(
      await realpath(source),
    );
  });
});

test("fails closed when a declared runtime dependency is missing", async () => {
  await withFixture(async ({ consumerNodeModules, runtimeDependenciesRoot }) => {
    await expect(
      exposeDeclaredRuntimeDependencies({
        consumerNodeModules,
        dependencies: { missing: "1.2.3" },
        runtimeDependenciesRoot,
      }),
    ).rejects.toThrow("declared runtime dependency is unavailable: missing@1.2.3");
  });
});

test("fails closed when a runtime dependency version does not match its exact requirement", async () => {
  await withFixture(async ({ consumerNodeModules, runtimeDependenciesRoot }) => {
    await writeDependency(runtimeDependenciesRoot, "runtime", "1.2.4");

    await expect(
      exposeDeclaredRuntimeDependencies({
        consumerNodeModules,
        dependencies: { runtime: "1.2.3" },
        runtimeDependenciesRoot,
      }),
    ).rejects.toThrow(
      "runtime dependency version mismatch for runtime: expected 1.2.3, received 1.2.4",
    );
  });
});

test("separates build dependencies from matrix-selected repository dependencies", async () => {
  await withFixture(async ({ consumerNodeModules, repository, root, runtimeDependenciesRoot }) => {
    await writeDependency(runtimeDependenciesRoot, "runtime", "1.18.21");
    const snapshotRoot = join(root, "build-runtime-snapshot");
    const snapshotDependency = await writeDependency(snapshotRoot, "runtime", "1.18.25");
    const resolvedSnapshot = await resolvePackedRuntimeDependenciesRoot(repository, {
      [packedRuntimeDependenciesRootEnvironmentVariable]: snapshotRoot,
    });

    await exposeDeclaredRuntimeDependencies({
      consumerNodeModules,
      dependencies: { runtime: "1.18.25" },
      runtimeDependenciesRoot: resolvedSnapshot,
    });

    expect(await realpath(join(consumerNodeModules, "runtime"))).toBe(
      await realpath(snapshotDependency),
    );
  });
});

test("rejects malformed, relative, and missing runtime dependency overrides", async () => {
  await withFixture(async ({ repository }) => {
    for (const override of ["", "relative/dependencies", join(dirname(repository), "missing")]) {
      await expect(
        resolvePackedRuntimeDependenciesRoot(repository, {
          [packedRuntimeDependenciesRootEnvironmentVariable]: override,
        }),
      ).rejects.toThrow(packedRuntimeDependenciesRootEnvironmentVariable);
    }
  });
});
