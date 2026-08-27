import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";
import { isAbsolute, normalize } from "node:path";

import { exportStageDirectoryName, validateExportDestination } from "../../domain/session-export";
import { ExportPathError, installLinuxExport } from "./linux-export-install";
import { LinuxExportStageCleanup } from "./linux-export-stage-cleanup";
import {
  LinuxSyscallError,
  linuxFlags,
  linuxMountId,
  mkdirAt,
  openAt,
  statFsType,
} from "./linux-syscalls";

export { ExportPathError } from "./linux-export-install";

const rejectedFileSystems = new Set<bigint>([
  0x0000_6969n, // NFS
  0x517bn, // SMB
  0xff53_4d42n, // CIFS
  0x0102_1997n, // 9P
  0x5346_414fn, // AFS
  0x7375_7245n, // Coda
  0x00c3_6400n, // Ceph
  0x0bd0_0bd0n, // Lustre
  0x7461_636fn, // OCFS2
  0x0116_1970n, // GFS2
  0x4750_4653n, // GPFS
  0x1983_0326n, // BeeGFS
  0xaad7_aaean, // PanFS
  0x2003_0528n, // OrangeFS / PVFS2
  0x6573_5546n, // FUSE cannot prove the local rename/durability contract.
]);

function closeSafely(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Cleanup must not replace the causal safe error.
  }
}

function assertPrivateDirectory(
  descriptor: number,
  requirePrivate: boolean,
  created = false,
): void {
  const stat = fstatSync(descriptor);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || uid === undefined || (requirePrivate && stat.uid !== uid)) {
    throw new ExportPathError("unsafe_path");
  }
  if (requirePrivate) {
    if ((stat.mode & 0o1022) !== 0) throw new ExportPathError("unsafe_path");
    if (!created && (stat.mode & 0o777) !== 0o700) throw new ExportPathError("unsafe_path");
    if (created) fchmodSync(descriptor, 0o700);
    const after = fstatSync(descriptor);
    if (after.uid !== uid || (after.mode & 0o777) !== 0o700) {
      throw new ExportPathError("unsafe_path");
    }
  }
}

function openDirectory(
  parent: number,
  component: string,
  create: boolean,
): { readonly descriptor: number; readonly created: boolean } {
  const flags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | linuxFlags.oCloexec;
  try {
    return { descriptor: openAt(parent, component, flags), created: false };
  } catch (cause: unknown) {
    if (!create || !(cause instanceof LinuxSyscallError) || cause.errno !== 2) {
      throw new ExportPathError("unsafe_path");
    }
  }
  let didCreate = false;
  try {
    mkdirAt(parent, component, 0o700);
    didCreate = true;
  } catch (cause: unknown) {
    if (!(cause instanceof LinuxSyscallError) || cause.errno !== 17) {
      throw new ExportPathError("storage_unavailable");
    }
  }
  let created: number;
  try {
    created = openAt(parent, component, flags);
  } catch {
    throw new ExportPathError("unsafe_path");
  }
  try {
    assertPrivateDirectory(created, true, didCreate);
    fsyncSync(created);
    fsyncSync(parent);
    return { descriptor: created, created: didCreate };
  } catch (cause: unknown) {
    closeSafely(created);
    if (cause instanceof ExportPathError) throw cause;
    throw new ExportPathError("storage_unavailable");
  }
}

function rootComponents(root: string): readonly string[] {
  if (
    process.platform !== "linux" ||
    !isAbsolute(root) ||
    root === "/" ||
    root.includes("\0") ||
    normalize(root) !== root
  ) {
    throw new ExportPathError("unsafe_path");
  }
  if (["/etc", "/usr", "/var", "/tmp", "/home", "/root", "/opt"].includes(root)) {
    throw new ExportPathError("unsafe_path");
  }
  const components = root.slice(1).split("/");
  if (components.some((value) => value === "" || value === "." || value === "..")) {
    throw new ExportPathError("unsafe_path");
  }
  return components;
}

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
      if (rejectedFileSystems.has(type)) {
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
