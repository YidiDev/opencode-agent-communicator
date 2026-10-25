import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseVersion, runtimeDigest } from "../../tools/release-policy.mjs";
import { runBoundedProcess } from "../live/harness/process";

export async function prepareFrozenRuntime(repository: string, artifact: string, work: string) {
  if (Bun.version !== "1.4.0" || process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Soak requires Linux x64 and Bun 1.4.0");
  const metadata = JSON.parse(await readFile(join(artifact, "release-metadata.json"), "utf8")) as {
    version: string;
    runtime_sha256: string;
  };
  const { version, tag } = releaseVersion(metadata.version);
  if (
    !/^[a-f0-9]{64}$/.test(metadata.runtime_sha256) ||
    (await runtimeDigest(repository)) !== metadata.runtime_sha256
  )
    throw new Error("Source runtime does not match the original release evidence");
  const filename = `opencode-agent-communicator-${version}.tgz`;
  const sums = (await readFile(join(artifact, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/));
  const expected = sums.filter((line) => line[1] === filename);
  const archiveSha256 = createHash("sha256")
    .update(await readFile(join(artifact, filename)))
    .digest("hex");
  if (expected.length !== 1 || expected[0]?.[0] !== archiveSha256)
    throw new Error("Original release archive checksum mismatch");
  const frozen = join(work, "frozen-runtime");
  await mkdir(frozen, { mode: 0o700 });
  const environment = {
    HOME: work,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NO_COLOR: "1",
    BUN_INSTALL_CACHE_DIR: join(work, "bun-cache"),
  };
  const listing = await runBoundedProcess({
    command: "tar",
    arguments: ["--list", "--gzip", "--file", join(artifact, filename)],
    cwd: work,
    environment,
  });
  const kinds = await runBoundedProcess({
    command: "tar",
    arguments: ["--list", "--verbose", "--gzip", "--file", join(artifact, filename)],
    cwd: work,
    environment,
  });
  if (
    listing.exitCode !== 0 ||
    kinds.exitCode !== 0 ||
    !listing.stdout.trim() ||
    listing.stdout
      .trim()
      .split("\n")
      .some((path) => !path.startsWith("package/") || path.split("/").includes("..")) ||
    kinds.stdout
      .trim()
      .split("\n")
      .some((line) => !line.startsWith("-"))
  )
    throw new Error("Release archive contains unsafe entries");
  const extracted = await runBoundedProcess({
    command: "tar",
    arguments: [
      "--extract",
      "--gzip",
      "--file",
      join(artifact, filename),
      "--directory",
      frozen,
      "--strip-components=1",
      "--no-same-owner",
    ],
    cwd: work,
    environment,
  });
  if (extracted.exitCode !== 0) throw new Error("Original release extraction failed");
  await copyFile(join(repository, "bun.lock"), join(frozen, "bun.lock"));
  if ((await runtimeDigest(frozen)) !== metadata.runtime_sha256)
    throw new Error("Extracted runtime does not match the release evidence");
  const manifest = JSON.parse(await readFile(join(frozen, "package.json"), "utf8")) as {
    scripts?: Record<string, unknown>;
  };
  if (
    [
      "preinstall",
      "install",
      "postinstall",
      "preprepare",
      "prepare",
      "postprepare",
      "prepublish",
    ].some((name) => manifest.scripts?.[name] !== undefined)
  )
    throw new Error("Release package must not execute root install lifecycle hooks");
  const installed = await runBoundedProcess({
    command: process.execPath,
    arguments: ["install", "--frozen-lockfile"],
    cwd: frozen,
    environment,
    deadlineMs: 300_000,
  });
  if (installed.exitCode !== 0 || (await runtimeDigest(frozen)) !== metadata.runtime_sha256)
    throw new Error("Frozen runtime installation failed or changed the release digest");
  return {
    frozen,
    archive_sha256: archiveSha256,
    runtime_sha256: metadata.runtime_sha256,
    version,
    tag,
  };
}

export async function runSoakCompanions(repository: string, smoke: boolean): Promise<void> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const clock = await runBoundedProcess({
    command: process.execPath,
    arguments: [
      "test",
      "--timeout=15000",
      "test/unit/application/request-deadline-scheduler.test.ts",
      "test/integration/adapters/store/sqlite-store-limits-recovery.test.ts",
      "test/integration/adapters/store/sqlite-request-admission-deadline.test.ts",
    ],
    cwd: repository,
    environment,
    deadlineMs: 180_000,
  });
  if (clock.exitCode !== 0)
    throw new Error("Controlled clock and store recovery regressions failed");
  if (!smoke) {
    const ownership = await runBoundedProcess({
      command: "bash",
      arguments: ["tools/run-linux-store-acceptance.sh"],
      cwd: repository,
      environment,
      deadlineMs: 1_200_000,
    });
    if (ownership.exitCode !== 0) throw new Error("Linux ownership and crash acceptance failed");
  }
}
