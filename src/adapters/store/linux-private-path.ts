import {
  closeSync,
  fchmodSync,
  constants as fileConstants,
  fstatSync,
  mkdirSync,
  openSync,
  statfsSync,
} from "node:fs";
import { isAbsolute, normalize } from "node:path";

import { descriptorPath, errorCode, safelyClose } from "./linux-path-operations";
import { PreparedPrivateState, type RetainedDirectory } from "./prepared-private-state";
import { type LinuxPathSyscalls, StoreSecurityError } from "./store-types";

export { PreparedPrivateState } from "./prepared-private-state";
export type { LinuxFileStat, LinuxPathSyscalls } from "./store-types";

const databaseNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fuseSuperMagic = 0x6573_5546n;

/** Filesystems whose locking or sharing model is outside the SQLite store contract. */
export const rejectedLinuxFileSystemMagic = Object.freeze([
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
] as const);

const rejectedFileSystems = new Set<bigint>(rejectedLinuxFileSystemMagic);

export const nodeLinuxPathSyscalls: LinuxPathSyscalls = {
  open: (path, flags, mode) =>
    mode === undefined ? openSync(path, flags) : openSync(path, flags, mode),
  close: closeSync,
  mkdir: (path, mode) => mkdirSync(path, { mode }),
  fstat: (descriptor) => {
    const value = fstatSync(descriptor);
    return {
      device: value.dev,
      inode: value.ino,
      uid: value.uid,
      mode: value.mode,
      size: value.size,
      nlink: value.nlink,
      isDirectory: value.isDirectory(),
      isFile: value.isFile(),
    };
  },
  fchmod: fchmodSync,
  statfsType: (path) => statfsSync(path, { bigint: true }).type,
  uid: () => (typeof process.getuid === "function" ? process.getuid() : undefined),
};

function assertPrivateDirectory(
  syscalls: LinuxPathSyscalls,
  descriptor: number,
  requireOwner: boolean,
  created = false,
): void {
  const before = syscalls.fstat(descriptor);
  if (!before.isDirectory) {
    throw new StoreSecurityError("The state path contains a non-directory component.");
  }
  const uid = syscalls.uid();
  if (uid === undefined || (requireOwner && before.uid !== uid)) {
    throw new StoreSecurityError("The private state directory has an unsafe owner.");
  }
  if (!requireOwner) return;
  // Never "repair" a shared/sticky final target. In particular, a root process must not
  // turn /tmp into 0700 before discovering that it was an unsafe configured state path.
  if ((before.mode & 0o1000) !== 0 || (before.mode & 0o022) !== 0) {
    throw new StoreSecurityError("The private state directory is shared or sticky.");
  }
  if (!created && (before.mode & 0o777) !== 0o700) {
    throw new StoreSecurityError("An existing private state directory must already be mode 0700.");
  }
  if (created) syscalls.fchmod(descriptor, 0o700);
  const after = syscalls.fstat(descriptor);
  if (!after.isDirectory || after.uid !== uid || (after.mode & 0o777) !== 0o700) {
    throw new StoreSecurityError("Private state-directory permissions could not be established.");
  }
}

/**
 * Existing traversal directories are trusted only when replacement by another UID is prevented.
 * Root/current-UID ownership plus no group/world write is the normal policy. A root-owned sticky
 * directory is the narrow exception needed to traverse standard private-temp parents such as
 * /tmp; sticky rename protection and the private child ownership check preserve the boundary.
 */
function assertTrustedTraversalDirectory(syscalls: LinuxPathSyscalls, descriptor: number): void {
  const value = syscalls.fstat(descriptor);
  const uid = syscalls.uid();
  if (uid === undefined || !value.isDirectory || (value.uid !== 0 && value.uid !== uid)) {
    throw new StoreSecurityError("The state path has an unsafe canonical ancestor.");
  }
  const sharedWrite = (value.mode & 0o022) !== 0;
  const safeStickyRoot = value.uid === 0 && (value.mode & 0o1000) !== 0;
  if (sharedWrite && !safeStickyRoot) {
    throw new StoreSecurityError("The state path has a writable canonical ancestor.");
  }
}

function validateDirectoryPath(directory: string): string[] {
  if (process.platform !== "linux" || !isAbsolute(directory)) {
    throw new StoreSecurityError("The SQLite adapter requires Linux and an absolute state path.");
  }
  if (directory === "/" || directory.includes("\0") || normalize(directory) !== directory) {
    throw new StoreSecurityError("The configured state directory is an unsafe target.");
  }
  if (["/etc", "/usr", "/var", "/tmp", "/home", "/root", "/opt"].includes(directory)) {
    throw new StoreSecurityError("The configured state directory must be a dedicated root.");
  }
  const components = directory.slice(1).split("/");
  if (
    components.length === 0 ||
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw new StoreSecurityError("The configured state directory is malformed.");
  }
  return components;
}

function openDirectoryComponent(
  syscalls: LinuxPathSyscalls,
  parent: number,
  component: string,
): { readonly descriptor: number; readonly created: boolean } {
  const path = descriptorPath(parent, component);
  const flags = fileConstants.O_RDONLY | fileConstants.O_DIRECTORY | fileConstants.O_NOFOLLOW;
  try {
    return { descriptor: syscalls.open(path, flags), created: false };
  } catch (cause: unknown) {
    if (errorCode(cause) !== "ENOENT") {
      throw new StoreSecurityError("A state-path component could not be opened safely.");
    }
  }
  let created = false;
  try {
    syscalls.mkdir(path, 0o700);
    created = true;
  } catch (cause: unknown) {
    if (errorCode(cause) !== "EEXIST") {
      throw new StoreSecurityError("A state-path component could not be created safely.");
    }
  }
  try {
    return { descriptor: syscalls.open(path, flags), created };
  } catch {
    throw new StoreSecurityError("A created state-path component could not be opened safely.");
  }
}

function assertSupportedFileSystem(
  syscalls: LinuxPathSyscalls,
  directoryDescriptor: number,
  allowFuse: boolean,
): void {
  const type = syscalls.statfsType(descriptorPath(directoryDescriptor));
  if (rejectedFileSystems.has(type) || (!allowFuse && type === fuseSuperMagic)) {
    throw new StoreSecurityError("The state directory uses an unsupported filesystem.");
  }
}

export function preparePrivateStatePath(
  directory: string,
  fileName: string,
  options: {
    readonly syscalls?: LinuxPathSyscalls;
    readonly allowFuse?: boolean;
  } = {},
): PreparedPrivateState {
  if (!databaseNamePattern.test(fileName)) {
    throw new StoreSecurityError("The database filename is malformed.");
  }
  const components = validateDirectoryPath(directory);
  const syscalls = options.syscalls ?? nodeLinuxPathSyscalls;
  let current: number;
  try {
    current = syscalls.open(
      "/",
      fileConstants.O_RDONLY | fileConstants.O_DIRECTORY | fileConstants.O_NOFOLLOW,
    );
  } catch {
    throw new StoreSecurityError("The filesystem root descriptor could not be opened.");
  }
  const directoryChain: RetainedDirectory[] = [{ descriptor: current }];
  try {
    assertTrustedTraversalDirectory(syscalls, current);
    for (const [index, component] of components.entries()) {
      const child = openDirectoryComponent(syscalls, current, component);
      try {
        if (child.created || index === components.length - 1) {
          assertPrivateDirectory(syscalls, child.descriptor, true, child.created);
        } else {
          assertTrustedTraversalDirectory(syscalls, child.descriptor);
        }
      } catch (cause: unknown) {
        safelyClose(syscalls, child.descriptor);
        throw cause;
      }
      current = child.descriptor;
      directoryChain.push({ descriptor: current, component });
    }
    assertSupportedFileSystem(syscalls, current, options.allowFuse === true);
    const prepared = new PreparedPrivateState(
      current,
      fileName,
      directory,
      syscalls,
      directoryChain,
    );
    prepared.verifySqliteFiles();
    return prepared;
  } catch (cause: unknown) {
    for (const entry of [...directoryChain].reverse()) {
      safelyClose(syscalls, entry.descriptor);
    }
    if (cause instanceof StoreSecurityError) throw cause;
    throw new StoreSecurityError("The private state path could not be prepared safely.");
  }
}
