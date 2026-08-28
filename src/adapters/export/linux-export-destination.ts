import { constants, fstatSync, fsyncSync, openSync, writeSync } from "node:fs";

import { exportStageDirectoryName, validateExportDestination } from "../../domain/session-export";
import { ExportPathError, installLinuxExport } from "./linux-export-install";
import {
  assertPrivateDirectory,
  closeSafely,
  isRejectedExportFileSystem,
  openDirectory,
  rootComponents,
} from "./linux-export-path";
import { LinuxExportStageCleanup } from "./linux-export-stage-cleanup";
import { LinuxSyscallError, linuxFlags, linuxMountId, openAt, statFsType } from "./linux-syscalls";

export { ExportPathError } from "./linux-export-install";

export interface LinuxExportTemporary {
  readonly descriptor: number;
  write(chunk: Uint8Array): void;
  install(shouldOverwrite: boolean): void;
  discard(): void;
}

export class LinuxExportRoot implements Disposable {
  private isClosed = false;
  private readonly stageCleanup: LinuxExportStageCleanup;

  private constructor(
    private readonly rootDescriptor: number,
    private readonly stagingDescriptor: number,
    private readonly rootDevice: bigint | number,
    private readonly rootFileSystem: bigint,
    private readonly rootMountId: string,
  ) {
    this.stageCleanup = new LinuxExportStageCleanup(stagingDescriptor, () => this.failClosed());
  }

  static open(root: string): LinuxExportRoot {
    let current = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let staging: number | undefined;
    try {
      assertPrivateDirectory(current, false);
      const components = rootComponents(root);
      for (const [index, component] of components.entries()) {
        const next = openDirectory(current, component, index === components.length - 1);
        try {
          assertPrivateDirectory(next.descriptor, index === components.length - 1, next.created);
        } catch (cause: unknown) {
          closeSafely(next.descriptor);
          throw cause;
        }
        closeSafely(current);
        current = next.descriptor;
      }
      const type = statFsType(current);
      if (isRejectedExportFileSystem(type)) {
        throw new ExportPathError("unsafe_path");
      }
      const rootDevice = fstatSync(current).dev;
      const rootMountId = linuxMountId(current);
      const openedStaging = openDirectory(current, exportStageDirectoryName, true);
      staging = openedStaging.descriptor;
      assertPrivateDirectory(staging, true, openedStaging.created);
      if (
        fstatSync(staging).dev !== rootDevice ||
        statFsType(staging) !== type ||
        linuxMountId(staging) !== rootMountId
      ) {
        throw new ExportPathError("unsafe_path");
      }
      const openedRoot = new LinuxExportRoot(current, staging, rootDevice, type, rootMountId);
      openedRoot.stageCleanup.start();
      staging = undefined;
      return openedRoot;
    } catch (cause: unknown) {
      if (staging !== undefined) closeSafely(staging);
      closeSafely(current);
      if (cause instanceof ExportPathError) throw cause;
      throw new ExportPathError("storage_unavailable");
    }
  }

  createTemporary(destination: string, randomName: string): LinuxExportTemporary {
    if (this.isClosed) throw new ExportPathError("storage_unavailable");
    const validated = validateExportDestination(destination);
    if (!validated.ok || !/^[a-f0-9]{32}$/.test(randomName)) {
      throw new ExportPathError("unsafe_path");
    }
    this.stageCleanup.beforeCreate();
    const components = [...validated.components];
    const finalName = components.pop();
    if (finalName === undefined) throw new ExportPathError("unsafe_path");
    let parent = openAt(
      this.rootDescriptor,
      ".",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | linuxFlags.oCloexec,
    );
    try {
      for (const component of components) {
        const next = openDirectory(parent, component, true);
        try {
          assertPrivateDirectory(next.descriptor, true, next.created);
          if (
            fstatSync(next.descriptor).dev !== this.rootDevice ||
            statFsType(next.descriptor) !== this.rootFileSystem ||
            linuxMountId(next.descriptor) !== this.rootMountId
          ) {
            throw new ExportPathError("unsafe_path");
          }
        } catch (cause: unknown) {
          closeSafely(next.descriptor);
          throw cause;
        }
        closeSafely(parent);
        parent = next.descriptor;
      }
      const stagingParent = openAt(
        this.stagingDescriptor,
        ".",
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | linuxFlags.oCloexec,
      );
      return this.openTemporary(
        parent,
        stagingParent,
        finalName,
        `.session-export-${randomName}.stage`,
      );
    } catch (cause: unknown) {
      closeSafely(parent);
      if (cause instanceof ExportPathError) throw cause;
      throw new ExportPathError("storage_unavailable");
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.stageCleanup.close();
    closeSafely(this.stagingDescriptor);
    closeSafely(this.rootDescriptor);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private failClosed(): void {
    this.close();
  }

  private openTemporary(
    parent: number,
    stagingParent: number,
    finalName: string,
    stagingName: string,
  ): LinuxExportTemporary {
    let descriptor: number | undefined;
    try {
      descriptor = openAt(
        parent,
        ".",
        linuxFlags.oTmpfile | constants.O_RDWR | linuxFlags.oCloexec,
        0o600,
      );
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 0 || (stat.mode & 0o777) !== 0o600) {
        throw new ExportPathError("unsafe_path");
      }
    } catch (cause: unknown) {
      if (descriptor !== undefined) closeSafely(descriptor);
      closeSafely(parent);
      closeSafely(stagingParent);
      if (
        cause instanceof LinuxSyscallError &&
        (cause.errno === 22 || cause.errno === 38 || cause.errno === 95)
      ) {
        throw new ExportPathError("unsafe_path");
      }
      throw cause instanceof ExportPathError ? cause : new ExportPathError("storage_unavailable");
    }
    const temporaryDescriptor = descriptor;
    let isFinished = false;
    const finish = (): void => {
      if (isFinished) return;
      isFinished = true;
      closeSafely(temporaryDescriptor);
      closeSafely(parent);
      closeSafely(stagingParent);
    };
    return {
      descriptor: temporaryDescriptor,
      write(chunk) {
        if (isFinished) throw new ExportPathError("storage_unavailable");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const count = writeSync(temporaryDescriptor, chunk, offset);
          if (count < 1) throw new ExportPathError("storage_unavailable");
          offset += count;
        }
      },
      install(shouldOverwrite) {
        if (isFinished) throw new ExportPathError("storage_unavailable");
        try {
          fsyncSync(temporaryDescriptor);
          installLinuxExport({
            parentDescriptor: parent,
            stagingParentDescriptor: stagingParent,
            temporaryDescriptor,
            destinationName: finalName,
            stagingName,
            shouldOverwrite,
          });
          finish();
        } catch (cause: unknown) {
          finish();
          if (cause instanceof ExportPathError) throw cause;
          throw new ExportPathError("storage_unavailable");
        }
      },
      discard() {
        if (isFinished) return;
        finish();
      },
    };
  }
}
