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
      {
        readonly env?: Record<string, unknown>;
        readonly steps?: readonly WorkflowStep[];
        readonly strategy?: { readonly matrix?: { readonly version?: readonly string[] } };
      }
    >;
  };
  const job = workflow.jobs?.["opencode-2"];
  expect(job?.strategy?.matrix?.version).toEqual(["2.1.3", "2.2.2"]);
  const steps = job?.steps ?? [];
  const prerequisites = steps.find((step) => step.name === "Verify live-gate prerequisites");
  const versionCheck = prerequisites?.run
    ?.split("\n")
    .find((line) => line.includes('/opencode" --version'));
  expect(versionCheck).toBeDefined();
  if (!versionCheck) throw new Error("Missing CLI version prerequisite");
  for (const [output, expected] of [
    ["opencode v2.1.3", 0],
    ["2.1.3", 1],
    ["opencode v2.1.4", 1],
  ] as const) {
    const process = Bun.spawn(
      [
        "bash",
        "-c",
        versionCheck.replace(
          '$("$host_root/node_modules/.bin/opencode" --version)',
          "$VERSION_OUTPUT",
        ),
      ],
      {
        env: { VERSION_OUTPUT: output, OPENCODE_COMPAT_VERSION: "2.1.3" },
      },
    );
    expect(await process.exited).toBe(expected);
  }
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

test("isolated newer CLI resolution checks exact version and refuses escaping binaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "compat-cli-resolution-"));
  try {
    const cli = join(root, "node_modules/@opencode/cli");
    await mkdir(join(cli, "bin"), { recursive: true });
    const manifest = { name: "@opencode/cli", version: "2.2.2", bin: { opencode: "bin/opencode" } };
    await writeFile(join(cli, "package.json"), JSON.stringify(manifest));
    await writeFile(join(cli, "bin/opencode"), "fixture");
    const resolver = resolve("test/live/harness/cli.ts");
    const script = `import { resolveExactProjectCli } from ${JSON.stringify(resolver)}; console.log(await resolveExactProjectCli("/unused-project"));`;
    async function invoke() {
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, OPENCODE_COMPAT_VERSION: "2.2.2", OPENCODE_COMPAT_CLI_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }
    expect(await invoke()).toEqual({
      exitCode: 0,
      stdout: `${join(cli, "bin/opencode")}\n`,
      stderr: "",
    });
    await writeFile(join(cli, "package.json"), JSON.stringify({ ...manifest, version: "2.2.1" }));
    expect((await invoke()).stderr).toContain("expected project-local @opencode/cli 2.2.2");
    await writeFile(join(cli, "package.json"), JSON.stringify(manifest));
    await rm(join(cli, "bin/opencode"));
    await writeFile(join(root, "outside"), "fixture");
    await symlink(join(root, "outside"), join(cli, "bin/opencode"));
    const escaped = await invoke();
    expect(escaped.exitCode).not.toBe(0);
    expect(escaped.stderr).toContain("opencode CLI resolved outside its exact package");
  } finally {
    await rm(root, { recursive: true, force: true });
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
