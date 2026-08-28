import { closeSync, constants, fchmodSync, fstatSync, fsyncSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

import { ExportPathError } from "./linux-export-install";
import { LinuxSyscallError, linuxFlags, mkdirAt, openAt } from "./linux-syscalls";

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

export function isRejectedExportFileSystem(type: bigint): boolean {
  return rejectedFileSystems.has(type);
}

export function closeSafely(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Cleanup must not replace the causal safe error.
  }
}

export function assertPrivateDirectory(
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

export function openDirectory(
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

export function rootComponents(root: string): readonly string[] {
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
