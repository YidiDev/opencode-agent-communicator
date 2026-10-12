import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fileSystem from "node:fs";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExportPathError,
  LinuxExportRoot,
} from "../../../../src/adapters/export/linux-export-destination";
import { exportStageDirectoryName } from "../../../../src/domain/session-export";
import { hasLinuxDescriptorInstall } from "../../../support/linux-export-capability";

const roots: string[] = [];

function temporaryRoot(): { readonly base: string; readonly exports: string } {
  const base = mkdtempSync(join(tmpdir(), "communicator-export-"));
  chmodSync(base, 0o700);
  roots.push(base);
  return { base, exports: join(base, "exports") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux descriptor-relative export destination", () => {
  test("rejects non-canonical and ambient system export roots", () => {
    for (const root of [
      "relative",
      "/",
      "/tmp",
      "/var",
      "/tmp/../tmp",
      "/tmp//nested",
      "/tmp/./nested",
      "/tmp/nul\0name",
    ]) {
      expect(() => LinuxExportRoot.open(root)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
    }
  });

  test("closes idempotently and refuses all temporary creation after close", () => {
    const paths = temporaryRoot();
    const root = LinuxExportRoot.open(paths.exports);
    root.close();
    root.close();
    expect(() => root.createTemporary("x.json", "a".repeat(32))).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
  });

  test("rejects malformed destination and staging identities before opening a temporary inode", () => {
    const paths = temporaryRoot();
    using root = LinuxExportRoot.open(paths.exports);
    for (const [destination, randomName] of [
      ["../escape", "a".repeat(32)],
      ["safe.json", "not-random"],
      ["safe.json", "A".repeat(32)],
    ] as const) {
      expect(() => root.createTemporary(destination as never, randomName)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
    }
  });

  test("keeps unsupported descriptor installation fail-closed and finalizes its temporary", () => {
    const paths = temporaryRoot();
    using root = LinuxExportRoot.open(paths.exports);
    let temporary: ReturnType<LinuxExportRoot["createTemporary"]>;
    try {
      temporary = root.createTemporary("x.json", "e".repeat(32));
    } catch (cause: unknown) {
      expect(cause).toBeInstanceOf(ExportPathError);
      return;
    }
    temporary.write(new TextEncoder().encode("private"));
    try {
      temporary.install(false);
    } catch (cause: unknown) {
      expect(cause).toBeInstanceOf(ExportPathError);
    }
    expect(() => temporary.write(new Uint8Array([1]))).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    expect(() => temporary.install(false)).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    temporary.discard();
  });

  test("maps unexpected descriptor failures to storage unavailable", () => {
    const paths = temporaryRoot();
    using root = LinuxExportRoot.open(paths.exports);
    root.createTemporary("nested/setup", "f".repeat(32)).discard();
    const stat = spyOn(fileSystem, "fstatSync").mockImplementation(() => {
      throw new Error("unexpected descriptor failure");
    });
    try {
      expect(() => root.createTemporary("nested/x.json", "f".repeat(32))).toThrow(
        expect.objectContaining({ kind: "storage_unavailable" }),
      );
    } finally {
      stat.mockRestore();
    }

    const temporary = root.createTemporary("x.json", "f".repeat(32));
    closeSync(temporary.descriptor);

    expect(() => temporary.install(false)).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    temporary.discard();
  });

  test("rejects an existing mode-0755 final root without changing it", () => {
    const paths = temporaryRoot();
    mkdirSync(paths.exports, { mode: 0o755 });
    chmodSync(paths.exports, 0o755);
    expect(() => LinuxExportRoot.open(paths.exports)).toThrow(ExportPathError);
    expect(lstatSync(paths.exports).mode & 0o777).toBe(0o755);
  });

  test.skipIf(!hasLinuxDescriptorInstall)(
    "creates private parents/temp and installs atomically without replacement",
    () => {
      const paths = temporaryRoot();
      using root = LinuxExportRoot.open(paths.exports);
      const temporary = root.createTemporary("nested/a;b $(no).json", "1".repeat(32));
      temporary.write(new TextEncoder().encode("first"));
      temporary.install(false);
      const destination = join(paths.exports, "nested", "a;b $(no).json");
      expect(readFileSync(destination, "utf8")).toBe("first");
      expect(lstatSync(destination).isFile()).toBe(true);
      expect(lstatSync(destination).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(paths.exports, "nested")).mode & 0o777).toBe(0o700);
      expect(existsSync(join(paths.base, "no"))).toBe(false);

      const collision = root.createTemporary("nested/a;b $(no).json", "2".repeat(32));
      collision.write(new TextEncoder().encode("second"));
      expect(() => collision.install(false)).toThrow(ExportPathError);
      expect(readFileSync(destination, "utf8")).toBe("first");
      expect(readdirSync(join(paths.exports, "nested"))).toEqual(["a;b $(no).json"]);
    },
  );

  test.skipIf(!hasLinuxDescriptorInstall)("supports atomic overwrite and create-if-absent", () => {
    const paths = temporaryRoot();
    using root = LinuxExportRoot.open(paths.exports);
    const first = root.createTemporary("nested/x.json", "3".repeat(32));
    first.write(new TextEncoder().encode("first"));
    first.install(true);
    expect(readFileSync(join(paths.exports, "nested", "x.json"), "utf8")).toBe("first");
    const replacement = root.createTemporary("nested/x.json", "4".repeat(32));
    replacement.write(new TextEncoder().encode("replacement"));
    const destination = join(paths.exports, "nested", "x.json");
    const oldTranscript = openSync(destination, "r");
    try {
      replacement.install(true);
      expect(readFileSync(destination, "utf8")).toBe("replacement");
      expect(fstatSync(oldTranscript).nlink).toBe(0);
      expect(readdirSync(paths.exports).sort()).toEqual([exportStageDirectoryName, "nested"]);
      expect(readdirSync(join(paths.exports, "nested"))).toEqual(["x.json"]);
    } finally {
      closeSync(oldTranscript);
    }
  });

  test.skipIf(!hasLinuxDescriptorInstall)(
    "rejects parent symlinks and nonblocking hostile destinations without writing outside",
    () => {
      const paths = temporaryRoot();
      mkdirSync(paths.exports, { mode: 0o700 });
      const outside = join(paths.base, "outside");
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, join(paths.exports, "linked"));
      using root = LinuxExportRoot.open(paths.exports);
      expect(() => root.createTemporary("linked/x.json", "5".repeat(32))).toThrow(ExportPathError);
      expect(existsSync(join(outside, "x.json"))).toBe(false);

      symlinkSync(join(outside, "victim"), join(paths.exports, "target.json"));
      const temporary = root.createTemporary("target.json", "6".repeat(32));
      temporary.write(new TextEncoder().encode("payload"));
      expect(() => temporary.install(true)).toThrow(ExportPathError);
      expect(lstatSync(join(paths.exports, "target.json")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(outside, "victim"))).toBe(false);
      expect(readdirSync(join(paths.exports, exportStageDirectoryName))).toEqual([]);

      const fifo = join(paths.exports, "pipe.json");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const fifoTemporary = root.createTemporary("pipe.json", "8".repeat(32));
      fifoTemporary.write(new TextEncoder().encode("payload"));
      const started = performance.now();
      expect(() => fifoTemporary.install(true)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(lstatSync(fifo).isFIFO()).toBe(true);
      expect(readdirSync(join(paths.exports, exportStageDirectoryName))).toEqual([]);
    },
  );

  test.skipIf(!hasLinuxDescriptorInstall)("discard removes every temporary artifact", () => {
    const paths = temporaryRoot();
    using root = LinuxExportRoot.open(paths.exports);
    const temporary = root.createTemporary("nested/x", "7".repeat(32));
    temporary.write(new TextEncoder().encode("private"));
    temporary.discard();
    expect(readdirSync(join(paths.exports, "nested"))).toEqual([]);
  });

  test("fails closed for a symlinked configured root", () => {
    const paths = temporaryRoot();
    const real = join(paths.base, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, paths.exports);
    expect(() => LinuxExportRoot.open(paths.exports)).toThrow(ExportPathError);
    writeFileSync(join(real, "untouched"), "yes");
    expect(readFileSync(join(real, "untouched"), "utf8")).toBe("yes");
  });
});
