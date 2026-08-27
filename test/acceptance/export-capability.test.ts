import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinuxExportRoot } from "../../src/adapters/export/linux-export-destination";
import { hasLinuxDescriptorInstall } from "../support/linux-export-capability";

const roots: string[] = [];

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "communicator-export-capability-"));
  chmodSync(base, 0o700);
  roots.push(base);
  return { base, destination: join(base, "exports") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("required Linux capability installs a descriptor-backed private export", () => {
  expect(process.env.REQUIRE_SECURE_EXPORT_CAPABILITY).toBe("1");
  expect(hasLinuxDescriptorInstall).toBe(true);
  const paths = fixture();
  using root = LinuxExportRoot.open(paths.destination);
  const temporary = root.createTemporary("nested/evidence.json", "a".repeat(32));
  temporary.write(new TextEncoder().encode("first"));
  temporary.install(false);
  const installed = join(paths.destination, "nested", "evidence.json");
  expect(readFileSync(installed, "utf8")).toBe("first");
  expect(lstatSync(installed).mode & 0o777).toBe(0o600);
});

test("required Linux capability performs atomic replacement", () => {
  expect(hasLinuxDescriptorInstall).toBe(true);
  const paths = fixture();
  using root = LinuxExportRoot.open(paths.destination);
  const first = root.createTemporary("evidence.json", "b".repeat(32));
  first.write(new TextEncoder().encode("first"));
  first.install(true);
  const replacement = root.createTemporary("evidence.json", "c".repeat(32));
  replacement.write(new TextEncoder().encode("replacement"));
  replacement.install(true);
  expect(readFileSync(join(paths.destination, "evidence.json"), "utf8")).toBe("replacement");
});
