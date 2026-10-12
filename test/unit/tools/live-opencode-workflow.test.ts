import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { packedRuntimeDependenciesRootEnvironmentVariable } from "../../live/harness/packed-plugin";

interface WorkflowStep {
  readonly env?: Record<string, unknown>;
  readonly name?: string;
  readonly run?: string;
}

test("snapshots build runtime dependencies before running the pinned v2 harness", async () => {
  const source = await Bun.file(".github/workflows/live-opencode.yml").text();
  const workflow = Bun.YAML.parse(source) as {
    readonly jobs?: Record<
      string,
      { readonly env?: Record<string, unknown>; readonly steps?: readonly WorkflowStep[] }
    >;
  };
  const job = workflow.jobs?.["opencode-2"];
  const steps = job?.steps ?? [];
  const names = steps.map((step) => step.name);

  const dependencyRoot = "$" + "{{ runner.temp }}/opencode-communicator-packed-runtime";
  const installIndex = names.indexOf("Install locked dependencies");
  const snapshotIndex = names.indexOf("Snapshot packed build runtime dependencies");
  const harnessIndex = names.indexOf("Run isolated compatibility harness");
  for (const index of [installIndex, snapshotIndex, harnessIndex]) {
    expect(index).toBeGreaterThanOrEqual(0);
  }
  expect(installIndex).toBeLessThan(snapshotIndex);
  expect(snapshotIndex).toBeLessThan(harnessIndex);
  const snapshot = steps.find((step) => step.name === "Snapshot packed build runtime dependencies");
  const liveHarness = steps.find((step) => step.name === "Run isolated compatibility harness");
  expect(snapshot?.run).toBe("node tools/snapshot-runtime-dependencies.mjs");
  expect(snapshot?.env?.OPENCODE_COMMUNICATOR_PACKED_RUNTIME_DEPENDENCIES_ROOT).toBe(
    dependencyRoot,
  );
  expect(liveHarness?.env?.OPENCODE_COMMUNICATOR_PACKED_RUNTIME_DEPENDENCIES_ROOT).toBe(
    dependencyRoot,
  );
  expect(job?.env?.OPENCODE_COMMUNICATOR_PACKED_RUNTIME_DEPENDENCIES_ROOT).toBeUndefined();
  for (const step of steps) {
    if (step === snapshot || step === liveHarness) continue;
    expect(step.env?.OPENCODE_COMMUNICATOR_PACKED_RUNTIME_DEPENDENCIES_ROOT).toBeUndefined();
  }
});

async function writePackage(directory: string, name: string, version: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
}

test("snapshot script materializes only exact declared runtime dependency directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-snapshot-script-"));
  try {
    const repository = join(root, "repository");
    const backing = join(root, "backing/runtime");
    const snapshot = join(root, "snapshot");
    await writePackage(backing, "@build/runtime", "1.18.25");
    await mkdir(join(repository, "node_modules/@build"), { recursive: true });
    await symlink(backing, join(repository, "node_modules/@build/runtime"), "dir");
    await writePackage(join(repository, "node_modules/unrelated"), "unrelated", "9.9.9");
    await mkdir(repository, { recursive: true });
    await writeFile(
      join(repository, "package.json"),
      `${JSON.stringify({ dependencies: { "@build/runtime": "1.18.25" } })}\n`,
    );

    const processResult = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../../tools/snapshot-runtime-dependencies.mjs"),
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          [packedRuntimeDependenciesRootEnvironmentVariable]: snapshot,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(await processResult.exited).toBe(0);
    expect(await new Response(processResult.stderr).text()).toBe("");
    expect(await readdir(snapshot)).toEqual(["@build"]);
    expect((await lstat(join(snapshot, "@build/runtime"))).isSymbolicLink()).toBe(false);
    expect(
      JSON.parse(await Bun.file(join(snapshot, "@build/runtime/package.json")).text()),
    ).toMatchObject({ name: "@build/runtime", version: "1.18.25" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
