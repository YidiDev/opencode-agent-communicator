import { closeSync, constants, fstatSync, fsyncSync } from "node:fs";

import {
  LinuxSyscallError,
  linkAtEmpty,
  linuxFlags,
  openAt,
  renameAt2Between,
  unlinkAt,
} from "./linux-syscalls";

export class ExportPathError extends Error {
  override readonly name = "ExportPathError";
  constructor(
    readonly kind:
      | "unsafe_path"
      | "destination_exists"
      | "native_outcome_unknown"
      | "storage_unavailable",
  ) {
    super("Secure export destination operation failed.");
  }
}

function closeSafely(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Retained inode cleanup has no pathname and cannot leave transcript data behind.
  }
}

function existingDestination(parent: number, name: string): number | undefined {
  try {
    return openAt(parent, name, linuxFlags.oPath | constants.O_NOFOLLOW | linuxFlags.oCloexec);
  } catch (cause: unknown) {
    if (cause instanceof LinuxSyscallError && cause.errno === 2) return undefined;
    throw new ExportPathError("unsafe_path");
  }
}

function assertPrivateRegular(descriptor: number): void {
  const value = fstatSync(descriptor);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    uid === undefined ||
    !value.isFile() ||
    value.uid !== uid ||
    value.nlink !== 1 ||
    (value.mode & 0o777) !== 0o600
  ) {
    throw new ExportPathError("unsafe_path");
  }
}

function verifyName(parent: number, name: string, source: number, postEffect: boolean): void {
  let current: number | undefined;
  try {
    current = openAt(parent, name, linuxFlags.oPath | constants.O_NOFOLLOW | linuxFlags.oCloexec);
    const expected = fstatSync(source);
    const observed = fstatSync(current);
    if (!observed.isFile() || expected.dev !== observed.dev || expected.ino !== observed.ino) {
      throw new Error("Installed name does not identify the retained inode.");
    }
  } catch {
    throw new ExportPathError(postEffect ? "native_outcome_unknown" : "storage_unavailable");
  } finally {
    if (current !== undefined) closeSafely(current);
  }
}

function noReplace(parent: number, name: string, temporary: number): void {
  try {
    linkAtEmpty(temporary, parent, name);
  } catch (cause: unknown) {
    if (cause instanceof LinuxSyscallError && cause.errno === 17) {
      throw new ExportPathError("destination_exists");
    }
    if (
      cause instanceof LinuxSyscallError &&
      (cause.errno === 1 ||
        cause.errno === 2 ||
        cause.errno === 22 ||
        cause.errno === 38 ||
        cause.errno === 95)
    ) {
      throw new ExportPathError("unsafe_path");
    }
    throw new ExportPathError("storage_unavailable");
  }
  verifyName(parent, name, temporary, true);
  try {
    fsyncSync(parent);
  } catch {
    throw new ExportPathError("native_outcome_unknown");
  }
}

function removeStage(parent: number, stage: string): void {
  try {
    unlinkAt(parent, stage);
    fsyncSync(parent);
  } catch {
    // Once linkStage succeeded, failure to prove removal can leave transcript bytes named.
    throw new ExportPathError("native_outcome_unknown");
  }
}

function removeStageThenThrow(parent: number, stage: string, cause: unknown): never {
  removeStage(parent, stage);
  throw cause;
}

function linkStage(parent: number, stage: string, temporary: number): void {
  try {
    linkAtEmpty(temporary, parent, stage);
  } catch (cause: unknown) {
    if (
      cause instanceof LinuxSyscallError &&
      (cause.errno === 1 ||
        cause.errno === 2 ||
        cause.errno === 22 ||
        cause.errno === 38 ||
        cause.errno === 95)
    ) {
      throw new ExportPathError("unsafe_path");
    }
    throw new ExportPathError("storage_unavailable");
  }
  try {
    fsyncSync(parent);
  } catch {
    throw new ExportPathError("native_outcome_unknown");
  }
}

function renameStageIfAbsent(
  stageParent: number,
  stage: string,
  destinationParent: number,
  name: string,
): boolean {
  try {
    renameAt2Between(stageParent, stage, destinationParent, name, linuxFlags.renameNoReplace);
    return true;
  } catch (cause: unknown) {
    if (cause instanceof LinuxSyscallError && cause.errno === 17) return false;
    throw new ExportPathError("storage_unavailable");
  }
}

function verifyApprovedDestination(parent: number, name: string, destination: number): void {
  let current: number | undefined;
  try {
    current = openAt(parent, name, linuxFlags.oPath | constants.O_NOFOLLOW | linuxFlags.oCloexec);
    assertPrivateRegular(current);
    const approved = fstatSync(destination);
    const observed = fstatSync(current);
    if (approved.dev !== observed.dev || approved.ino !== observed.ino) {
      throw new ExportPathError("unsafe_path");
    }
  } catch (cause: unknown) {
    if (cause instanceof ExportPathError) throw cause;
    throw new ExportPathError("unsafe_path");
  } finally {
    if (current !== undefined) closeSafely(current);
  }
}

function replaceStage(
  stageParent: number,
  stage: string,
  destinationParent: number,
  name: string,
): void {
  try {
    // A plain descriptor-relative rename atomically removes the replaced inode's only name.
    // RENAME_EXCHANGE is intentionally not used: a crash after exchange would retain the old
    // transcript under `stage` until a later cleanup operation happened to run.
    renameAt2Between(stageParent, stage, destinationParent, name, 0);
  } catch {
    removeStage(stageParent, stage);
    throw new ExportPathError("storage_unavailable");
  }
}

function flushRenameParents(stageParent: number, destinationParent: number): void {
  try {
    fsyncSync(destinationParent);
    if (stageParent !== destinationParent) fsyncSync(stageParent);
  } catch {
    throw new ExportPathError("native_outcome_unknown");
  }
}

function overwrite(
  parent: number,
  stageParent: number,
  name: string,
  stage: string,
  temporary: number,
): void {
  linkStage(stageParent, stage, temporary);
  let initial: number | undefined;
  try {
    initial = existingDestination(parent, name);
  } catch (cause: unknown) {
    removeStageThenThrow(stageParent, stage, cause);
  }
  let installedIfAbsent = false;
  if (initial === undefined) {
    try {
      installedIfAbsent = renameStageIfAbsent(stageParent, stage, parent, name);
    } catch (cause: unknown) {
      removeStageThenThrow(stageParent, stage, cause);
    }
  }
  if (installedIfAbsent) {
    verifyName(parent, name, temporary, true);
    try {
      flushRenameParents(stageParent, parent);
      return;
    } catch {
      throw new ExportPathError("native_outcome_unknown");
    }
  }
  let destination: number | undefined;
  try {
    destination = initial ?? existingDestination(parent, name);
  } catch (cause: unknown) {
    removeStageThenThrow(stageParent, stage, cause);
  }
  if (destination === undefined) {
    removeStageThenThrow(stageParent, stage, new ExportPathError("unsafe_path"));
  }
  try {
    try {
      assertPrivateRegular(destination);
      verifyApprovedDestination(parent, name, destination);
    } catch (cause: unknown) {
      removeStageThenThrow(stageParent, stage, cause);
    }
    try {
      replaceStage(stageParent, stage, parent, name);
      verifyName(parent, name, temporary, true);
      flushRenameParents(stageParent, parent);
    } catch (cause: unknown) {
      if (cause instanceof ExportPathError) throw cause;
      throw new ExportPathError("native_outcome_unknown");
    }
  } finally {
    closeSafely(destination);
  }
}

export function installLinuxExport(input: {
  readonly parentDescriptor: number;
  readonly stagingParentDescriptor: number;
  readonly temporaryDescriptor: number;
  readonly destinationName: string;
  readonly stagingName: string;
  readonly shouldOverwrite: boolean;
}): void {
  if (input.shouldOverwrite) {
    overwrite(
      input.parentDescriptor,
      input.stagingParentDescriptor,
      input.destinationName,
      input.stagingName,
      input.temporaryDescriptor,
    );
    return;
  }
  noReplace(input.parentDescriptor, input.destinationName, input.temporaryDescriptor);
}
