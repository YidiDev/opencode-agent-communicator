import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { runBoundedProcess } from "../live/harness/process";
import type { ArtifactWriter } from "./artifacts";

interface PackRecord {
  readonly filename?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
  readonly files?: unknown;
}

export interface InstalledPackage {
  readonly entry: string;
  readonly packageDirectory: string;
}

const setupDeadlineMs = 180_000;

function isContained(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function environment(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    npm_config_cache: join(home, ".npm"),
    NO_COLOR: "1",
  };
}

export async function packAndInstall(
  repository: string,
  privateRoot: string,
  artifacts: ArtifactWriter,
): Promise<InstalledPackage> {
  const packDirectory = join(privateRoot, "pack");
  const consumer = join(privateRoot, "consumer");
  const home = join(privateRoot, "npm-home");
  await Promise.all(
    [packDirectory, consumer, home].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  const env = environment(home);
  const packed = await runBoundedProcess({
    command: "npm",
    arguments: ["pack", "--json", "--pack-destination", packDirectory],
    cwd: repository,
    environment: env,
    deadlineMs: setupDeadlineMs,
  });
  await artifacts.process("pack", packed);
  if (packed.exitCode !== 0) throw new Error("npm pack failed");
  const report = JSON.parse(packed.stdout) as PackRecord[];
  const record = report[0];
  if (record === undefined || typeof record.filename !== "string")
    throw new Error("npm pack produced no archive");
  const archive = join(packDirectory, record.filename);
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await artifacts.json("pack-report.json", report);
  await artifacts.text("pack-sha256.txt", `${digest}  ${record.filename}\n`);

  const installed = await runBoundedProcess({
    command: "npm",
    arguments: ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive],
    cwd: consumer,
    environment: env,
    deadlineMs: setupDeadlineMs,
  });
  await artifacts.process("npm-install", installed);
  if (installed.exitCode !== 0) throw new Error("archive installation failed");
  const listed = await runBoundedProcess({
    command: "npm",
    arguments: ["ls", "--all", "--json"],
    cwd: consumer,
    environment: env,
    deadlineMs: setupDeadlineMs,
  });
  await artifacts.text("npm-ls.json", listed.stdout || listed.stderr);
  if (listed.exitCode !== 0) throw new Error("installed dependency tree is invalid");

  if (typeof record.name !== "string") throw new Error("pack report has no package name");
  const packageDirectory = await realpath(join(consumer, "node_modules", record.name));
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    main?: unknown;
  };
  if (
    manifest.name !== record.name ||
    manifest.version !== record.version ||
    typeof manifest.main !== "string"
  ) {
    throw new Error("installed package metadata differs from pack report");
  }
  const entry = await realpath(join(packageDirectory, manifest.main));
  if (!isContained(packageDirectory, entry)) throw new Error("installed entry escapes its package");
  await Promise.all([
    access(join(packageDirectory, "skills", "session-communication", "SKILL.md")),
    access(join(packageDirectory, "skills", "session-locks", "SKILL.md")),
    access(join(packageDirectory, "skills", "session-request-participant", "SKILL.md")),
  ]);
  await artifacts.json("installed-package.json", {
    name: manifest.name,
    version: manifest.version,
    entry,
    skills: ["session-communication", "session-locks", "session-request-participant"],
  });
  return { entry, packageDirectory };
}
