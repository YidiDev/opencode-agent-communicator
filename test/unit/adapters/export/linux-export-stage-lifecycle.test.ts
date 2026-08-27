import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinuxExportRoot } from "../../../../src/adapters/export/linux-export-destination";
import {
  cleanupStaleExportStages,
  type ExportStageCleanupScheduler,
  exportStageCleanupMaximumEntries,
  exportStageMinimumAgeMs,
  LinuxExportStageCleanup,
} from "../../../../src/adapters/export/linux-export-stage-cleanup";
import { exportStageDirectoryName } from "../../../../src/domain/session-export";

const roots: string[] = [];
const stageName = `.session-export-${"a".repeat(32)}.stage`;

class FakeSchedule implements ExportStageCleanupScheduler<number> {
  callback: (() => void) | undefined;
  throwOnUnref = false;
  now = Date.now();
  repeats = 0;
  unrefs = 0;
  cancels = 0;

  nowMs(): number {
    return this.now;
  }
  repeat(callback: () => void): number {
    this.repeats += 1;
    this.callback = callback;
    return 1;
  }
  unref(): void {
    this.unrefs += 1;
    if (this.throwOnUnref) throw new Error("unref failed");
  }
  cancel(): void {
    this.cancels += 1;
    this.callback = undefined;
  }
}

function fixture(): { readonly root: string; readonly descriptor: number } {
  const root = mkdtempSync(join(tmpdir(), "communicator-stage-lifecycle-"));
  chmodSync(root, 0o700);
  const staging = join(root, exportStageDirectoryName);
  mkdirSync(staging, { mode: 0o700 });
  chmodSync(staging, 0o700);
  roots.push(root);
  return { root, descriptor: openSync(staging, constants.O_RDONLY | constants.O_DIRECTORY) };
}

function privateStage(root: string): string {
  const path = join(root, exportStageDirectoryName, stageName);
  writeFileSync(path, "transcript", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux stale export stage lifecycle", () => {
  test("preserves fresh stages and next-open removes exact stale root stages", () => {
    const value = fixture();
    const path = privateStage(value.root);
    const unrelated = join(value.root, exportStageDirectoryName, `${stageName}.extra`);
    writeFileSync(unrelated, "unrelated", { mode: 0o600 });
    closeSync(value.descriptor);
    const changedMs = lstatSync(path).ctimeMs;

    using fresh = LinuxExportRoot.open(value.root);
    expect(existsSync(path)).toBe(true);
    fresh.close();
    const realNow = Date.now;
    Date.now = () => changedMs + exportStageMinimumAgeMs + 1;
    try {
      using _reopened = LinuxExportRoot.open(value.root);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  test("rejects matching hostile symlinks and objects without deleting them", () => {
    for (const kind of ["symlink", "directory", "broad", "hardlink"] as const) {
      const value = fixture();
      const path = join(value.root, exportStageDirectoryName, stageName);
      closeSync(value.descriptor);
      if (kind === "symlink") symlinkSync("/dev/null", path);
      if (kind === "directory") mkdirSync(path, { mode: 0o700 });
      if (kind === "broad") writeFileSync(path, "broad", { mode: 0o644 });
      if (kind === "hardlink") {
        const source = join(value.root, "source");
        writeFileSync(source, "linked", { mode: 0o600 });
        linkSync(source, path);
      }
      expect(() => LinuxExportRoot.open(value.root)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
      expect(existsSync(path)).toBe(true);
    }
  });

  test("periodically removes stale stages and disposes its unrefed timer exactly once", () => {
    const value = fixture();
    const schedule = new FakeSchedule();
    const cleaner = new LinuxExportStageCleanup(value.descriptor, () => undefined, schedule);
    cleaner.start();
    const path = privateStage(value.root);
    schedule.now = lstatSync(path).ctimeMs + exportStageMinimumAgeMs + 1;
    schedule.callback?.();
    expect(existsSync(path)).toBe(false);
    cleaner.close();
    cleaner.close();
    expect([schedule.repeats, schedule.unrefs, schedule.cancels]).toEqual([1, 1, 1]);
    closeSync(value.descriptor);

    const failedValue = fixture();
    const failedSchedule = new FakeSchedule();
    failedSchedule.throwOnUnref = true;
    const failed = new LinuxExportStageCleanup(
      failedValue.descriptor,
      () => undefined,
      failedSchedule,
    );
    expect(() => failed.start()).toThrow("unref failed");
    expect(failedSchedule.cancels).toBe(1);
    closeSync(failedValue.descriptor);
  });
});

describe("Linux stale export lifecycle faults", () => {
  test("periodic and before-create faults stop the timer and fail future cleanup closed", () => {
    for (const trigger of ["periodic", "before-create"] as const) {
      const value = fixture();
      const schedule = new FakeSchedule();
      let faults = 0;
      const cleaner = new LinuxExportStageCleanup(
        value.descriptor,
        () => {
          faults += 1;
        },
        schedule,
      );
      cleaner.start();
      symlinkSync("/dev/null", join(value.root, exportStageDirectoryName, stageName));
      if (trigger === "periodic") {
        const periodic = schedule.callback;
        periodic?.();
        periodic?.();
      } else {
        expect(() => cleaner.beforeCreate()).toThrow(
          expect.objectContaining({ kind: "unsafe_path" }),
        );
      }
      expect(faults).toBe(1);
      expect(schedule.cancels).toBe(1);
      expect(() => cleaner.beforeCreate()).toThrow(
        expect.objectContaining({ kind: "storage_unavailable" }),
      );
      closeSync(value.descriptor);
    }
  });

  test("a root cleanup fault closes all future export creation", () => {
    const value = fixture();
    closeSync(value.descriptor);
    const root = LinuxExportRoot.open(value.root);
    const hostile = join(value.root, exportStageDirectoryName, stageName);
    symlinkSync("/dev/null", hostile);
    expect(() => root.createTemporary("x", "9".repeat(32))).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );
    rmSync(hostile);
    expect(() => root.createTemporary("x", "9".repeat(32))).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    root.close();
  });

  test("bounds only reserved crash-stage candidates", () => {
    const value = fixture();
    const staging = join(value.root, exportStageDirectoryName);
    for (let index = 0; index <= exportStageCleanupMaximumEntries; index += 1) {
      writeFileSync(join(staging, `ordinary-${index}`), "x", { mode: 0o600 });
    }
    expect(() => cleanupStaleExportStages(value.descriptor, Date.now())).not.toThrow();
    for (let index = 0; index <= exportStageCleanupMaximumEntries; index += 1) {
      const identity = index.toString(16).padStart(32, "0");
      writeFileSync(join(staging, `.session-export-${identity}.stage`), "x", { mode: 0o600 });
    }
    expect(() => cleanupStaleExportStages(value.descriptor, Date.now())).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );
    closeSync(value.descriptor);
  }, 60_000);
});
