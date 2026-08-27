import { closeSync, constants, fstatSync, fsyncSync, opendirSync, type Stats } from "node:fs";

import { isReservedExportPathComponent } from "../../domain/session-export";
import { ExportPathError } from "./linux-export-install";
import { LinuxSyscallError, linuxFlags, openAt, unlinkAt } from "./linux-syscalls";

export const exportStageMinimumAgeMs = 15 * 60 * 1_000;
export const exportStageCleanupIntervalMs = 60 * 1_000;
export const exportStageCleanupMaximumEntries = 4_096;

const metadataFlags = linuxFlags.oPath | constants.O_NOFOLLOW | linuxFlags.oCloexec;

interface StageIdentity {
  readonly device: bigint | number;
  readonly inode: bigint | number;
  readonly changedMs: number;
}

export interface ExportStageCleanupScheduler<Handle = unknown> {
  nowMs(): number;
  repeat(callback: () => void, intervalMs: number): Handle;
  unref(handle: Handle): void;
  cancel(handle: Handle): void;
}

const scheduler: ExportStageCleanupScheduler<ReturnType<typeof setInterval>> = {
  nowMs: () => Date.now(),
  repeat: setInterval,
  unref: (handle) => handle.unref(),
  cancel: clearInterval,
};

function closeSafely(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Cleanup is already fail-closed; descriptor close cannot make it safer to continue.
  }
}

function metadata(parent: number, name: string): { descriptor: number; stat: Stats } | undefined {
  let descriptor: number;
  try {
    descriptor = openAt(parent, name, metadataFlags);
  } catch (cause: unknown) {
    if (cause instanceof LinuxSyscallError && cause.errno === 2) return undefined;
    throw new ExportPathError("storage_unavailable");
  }
  try {
    return { descriptor, stat: fstatSync(descriptor) as Stats };
  } catch {
    closeSafely(descriptor);
    throw new ExportPathError("storage_unavailable");
  }
}

function assertStage(stat: Stats): StageIdentity {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    uid === undefined ||
    !stat.isFile() ||
    stat.uid !== uid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new ExportPathError("unsafe_path");
  }
  return { device: stat.dev, inode: stat.ino, changedMs: stat.ctimeMs };
}

function sameIdentity(left: StageIdentity, right: StageIdentity): boolean {
  return (
    left.device === right.device && left.inode === right.inode && left.changedMs === right.changedMs
  );
}

function removeIfStale(parent: number, name: string, nowMs: number): void {
  const first = metadata(parent, name);
  if (first === undefined) return;
  let identity: StageIdentity;
  try {
    identity = assertStage(first.stat);
  } finally {
    closeSafely(first.descriptor);
  }
  if (nowMs - identity.changedMs < exportStageMinimumAgeMs) return;

  const second = metadata(parent, name);
  if (second === undefined) return;
  try {
    if (!sameIdentity(identity, assertStage(second.stat))) {
      throw new ExportPathError("unsafe_path");
    }
  } finally {
    closeSafely(second.descriptor);
  }
  try {
    unlinkAt(parent, name);
  } catch (cause: unknown) {
    if (!(cause instanceof LinuxSyscallError) || cause.errno !== 2) {
      throw new ExportPathError("storage_unavailable");
    }
  }
  try {
    fsyncSync(parent);
  } catch {
    throw new ExportPathError("storage_unavailable");
  }
}

export function cleanupStaleExportStages(parent: number, nowMs: number): void {
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(`/proc/self/fd/${parent}`);
  } catch {
    throw new ExportPathError("storage_unavailable");
  }
  let candidates = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (!isReservedExportPathComponent(entry.name)) continue;
      candidates += 1;
      if (candidates > exportStageCleanupMaximumEntries) {
        throw new ExportPathError("unsafe_path");
      }
      removeIfStale(parent, entry.name, nowMs);
    }
  } finally {
    try {
      directory.closeSync();
    } catch {
      // A prior cleanup fault remains authoritative.
    }
  }
}

export class LinuxExportStageCleanup<Handle = ReturnType<typeof setInterval>> {
  private handle: Handle | undefined;
  private faulted = false;

  constructor(
    private readonly rootDescriptor: number,
    private readonly onFault: () => void,
    private readonly schedule: ExportStageCleanupScheduler<Handle> = scheduler as ExportStageCleanupScheduler<Handle>,
  ) {}

  start(): void {
    cleanupStaleExportStages(this.rootDescriptor, this.schedule.nowMs());
    this.handle = this.schedule.repeat(() => this.runPeriodic(), exportStageCleanupIntervalMs);
    try {
      this.schedule.unref(this.handle);
    } catch (cause: unknown) {
      this.close();
      throw cause;
    }
  }

  beforeCreate(): void {
    if (this.faulted) throw new ExportPathError("storage_unavailable");
    try {
      cleanupStaleExportStages(this.rootDescriptor, this.schedule.nowMs());
    } catch (cause: unknown) {
      this.fail();
      throw cause;
    }
  }

  close(): void {
    if (this.handle === undefined) return;
    this.schedule.cancel(this.handle);
    this.handle = undefined;
  }

  private runPeriodic(): void {
    try {
      cleanupStaleExportStages(this.rootDescriptor, this.schedule.nowMs());
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    if (this.faulted) return;
    this.faulted = true;
    this.close();
    this.onFault();
  }
}
