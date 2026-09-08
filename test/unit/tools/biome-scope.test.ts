import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface ToolingPackage {
  readonly scripts: {
    readonly format: string;
    readonly "format:check": string;
    readonly lint: string;
  };
}

const repositoryRoot = resolve(import.meta.dir, "../../..");
const temporaryRoots: string[] = [];

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function runScript(root: string, script: keyof ToolingPackage["scripts"]): Promise<string> {
  const result = Bun.spawnSync(["bun", "run", script], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(repositoryRoot, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(0);
  return output;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Biome script scope", () => {
  test("format write/check and lint ignore nested temporary worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-scope-"));
    temporaryRoots.push(root);

    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as ToolingPackage;
    await write(
      root,
      "package.json",
      `${JSON.stringify({ scripts: packageJson.scripts }, null, 2)}\n`,
    );
    await write(root, ".gitignore", await readFile(join(repositoryRoot, ".gitignore"), "utf8"));
    await write(root, "biome.json", await readFile(join(repositoryRoot, "biome.json"), "utf8"));
    await write(root, "src/index.ts", "export const answer={value:42};\n");

    const nestedSource = "const = ;\n";
    await write(root, "opencode/tmp/worktrees/foreign/biome.json", "{ not valid json\n");
    await write(root, "opencode/tmp/worktrees/foreign/src/index.ts", nestedSource);

    await runScript(root, "format");
    expect(await readFile(join(root, "src/index.ts"), "utf8")).toBe(
      "export const answer = { value: 42 };\n",
    );
    expect(await readFile(join(root, "opencode/tmp/worktrees/foreign/src/index.ts"), "utf8")).toBe(
      nestedSource,
    );

    await runScript(root, "format:check");
    await runScript(root, "lint");
  });
});
