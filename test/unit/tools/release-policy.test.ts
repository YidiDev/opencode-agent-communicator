import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { licenseInventory } from "../../../tools/check-licenses.mjs";
import {
  assertStableReadiness,
  releaseVersion,
  runtimeDigest,
} from "../../../tools/release-policy.mjs";

test("release versions have explicit stable and RC channels with no tag injection", () => {
  expect(releaseVersion("1.0.0-rc.1")).toEqual({
    version: "1.0.0-rc.1",
    tag: "v1.0.0-rc.1",
    prerelease: true,
    distTag: "next",
  });
  expect(releaseVersion("2.3.4").distTag).toBe("latest");
  for (const version of [
    null,
    "0.9.1",
    "v1.0.0",
    "01.0.0",
    "1.0.0-rc.0",
    "1.0.0+meta",
    "1.0.0-beta.1",
    "1.0.0\n",
    "1.0.0-rc.9007199254740992",
  ])
    expect(() => releaseVersion(version)).toThrow();
});

test("stable publication requires reviewed 48-hour evidence bound to the exact runtime digest", () => {
  const digest = "a".repeat(64);
  const valid = {
    schema_version: 1,
    stable_approved: true,
    soak: {
      result: "passed",
      duration_hours: 48,
      runtime_sha256: digest,
      report_url: "https://github.com/YidiDev/opencode-agent-communicator/issues/46#evidence",
    },
  };
  expect(() => assertStableReadiness("1.0.0", valid, digest)).not.toThrow();
  expect(() => assertStableReadiness("1.0.0-rc.1", {}, digest)).not.toThrow();
  for (const readiness of [
    {},
    { ...valid, stable_approved: false },
    { ...valid, schema_version: 2 },
    ...[
      { duration_hours: 47 },
      { duration_hours: NaN },
      { result: "pending" },
      { runtime_sha256: "b".repeat(64) },
      { report_url: "https://example.com/report" },
    ].map((change) => ({ ...valid, soak: { ...valid.soak, ...change } })),
  ])
    expect(() => assertStableReadiness("1.0.0", readiness, digest)).toThrow("48-hour");
});

test("runtime evidence ignores release-only metadata but rejects source, dependency and symlink changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-runtime-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "skills"));
    await writeFile(join(root, "src/index.ts"), "export {};\n");
    await writeFile(join(root, "bun.lock"), "locked");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "1.0.0-rc.1", dependencies: { example: "1.0.0" } }),
    );
    const before = await runtimeDigest(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "1.0.0", dependencies: { example: "1.0.0" } }),
    );
    expect(await runtimeDigest(root)).toBe(before);
    await writeFile(join(root, "src/index.ts"), "export const changed = true;\n");
    expect(await runtimeDigest(root)).not.toBe(before);
    await symlink("index.ts", join(root, "src/linked.ts"));
    await expect(runtimeDigest(root)).rejects.toThrow("symlinks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production license inventory is deterministic and rejects unknown or conflicting declarations", () => {
  const root = { name: "root", location: "" };
  const a = { name: "example", version: "1.2.3", license: "MIT" };
  const b = { name: "@example/library", version: "0.1.0", license: "Apache-2.0" };
  expect(licenseInventory([root, a, b, a], "root")).toEqual(licenseInventory([b, a], "root"));
  for (const packages of [
    null,
    [],
    [root],
    [null],
    [{ ...a, name: "../escape" }],
    [{ ...a, version: "1\n" }],
    [{ ...a, license: "UNKNOWN" }],
    [a, { ...a, license: "ISC" }],
  ])
    expect(() => licenseInventory(packages, "root")).toThrow();
});
