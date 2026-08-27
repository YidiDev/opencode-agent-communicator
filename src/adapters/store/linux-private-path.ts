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

import { type LinuxFileStat, type LinuxPathSyscalls, StoreSecurityError } from "./store-types";

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

function descriptorPath(descriptor: number, name?: string): string {
  const base = `/proc/self/fd/${descriptor}`;
  return name === undefined ? base : `${base}/${name}`;
}

function errorCode(cause: unknown): unknown {
  return cause instanceof Error && "code" in cause ? cause.code : undefined;
}

function safelyClose(syscalls: LinuxPathSyscalls, descriptor: number): void {
  try {
    syscalls.close(descriptor);
  } catch {
    // Closing after another failure is best effort; the original safe diagnostic wins.
  }
}

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

interface FileSizes {
  readonly database: number;
  readonly wal: number;
  readonly shm: number;
  readonly journal: number;
}

export class PreparedPrivateState implements Disposable {
  readonly canonicalDatabasePath: string;
  readonly sqliteDatabasePath: string;
  private isClosed = false;

  constructor(
    readonly directoryDescriptor: number,
    readonly databaseFileName: string,
    canonicalDirectory: string,
    private readonly syscalls: LinuxPathSyscalls,
    private readonly directoryChain: readonly {
      readonly descriptor: number;
      readonly component?: string;
    }[],
  ) {
    this.canonicalDatabasePath = `${canonicalDirectory}/${databaseFileName}`;
    // Bun SQLite cannot combine SQLITE_OPEN_NOFOLLOW with /proc/self/fd because the proc entry is
    // itself a symlink. The retained trusted ancestor chain fences the canonical pathname instead.
    this.sqliteDatabasePath = this.canonicalDatabasePath;
  }

  assertPathIdentity(): void {
    this.assertOpen();
    this.assertRetainedDirectoryChain();
  }

  verifySqliteFiles(): void {
    this.assertOpen();
    this.assertRetainedDirectoryChain();
    this.verifyFile(this.databaseFileName, true);
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      this.verifyFile(`${this.databaseFileName}${suffix}`, false);
    }
  }

  assertMutationCapacity(maximumDatabaseBytes: number, checkpoint: () => void): void {
    this.assertOpen();
    this.assertRetainedDirectoryChain();
    let sizes = this.readSizes();
    if (this.exceedsCeiling(sizes, maximumDatabaseBytes)) {
      try {
        checkpoint();
      } catch {
        throw new StoreSecurityError("SQLite growth could not be checkpointed safely.");
      }
      this.verifySqliteFiles();
      sizes = this.readSizes();
      if (this.exceedsCeiling(sizes, maximumDatabaseBytes)) {
        throw new StoreSecurityError("SQLite storage has exceeded its configured byte ceiling.");
      }
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const entry of [...this.directoryChain].reverse()) {
      safelyClose(this.syscalls, entry.descriptor);
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private verifyFile(name: string, create: boolean): LinuxFileStat | undefined {
    const flags = fileConstants.O_RDWR | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK;
    let descriptor: number;
    let created = false;
    try {
      descriptor = this.syscalls.open(descriptorPath(this.directoryDescriptor, name), flags);
    } catch (cause: unknown) {
      if (!create && errorCode(cause) === "ENOENT") return undefined;
      if (!create || errorCode(cause) !== "ENOENT") {
        throw new StoreSecurityError("A SQLite state file could not be opened safely.");
      }
      try {
        descriptor = this.syscalls.open(
          descriptorPath(this.directoryDescriptor, name),
          flags | fileConstants.O_CREAT | fileConstants.O_EXCL,
          0o600,
        );
        created = true;
      } catch {
        throw new StoreSecurityError("A SQLite state file could not be created safely.");
      }
    }
    try {
      const uid = this.syscalls.uid();
      const before = this.syscalls.fstat(descriptor);
      if (
        uid === undefined ||
        !before.isFile ||
        before.uid !== uid ||
        before.nlink !== 1 ||
        !Number.isSafeInteger(before.size) ||
        before.size < 0
      ) {
        throw new StoreSecurityError("A SQLite state file has an unsafe type or owner.");
      }
      if (!created && (before.mode & 0o777) !== 0o600) {
        throw new StoreSecurityError("An existing SQLite state file must already be mode 0600.");
      }
      if (created) this.syscalls.fchmod(descriptor, 0o600);
      const after = this.syscalls.fstat(descriptor);
      if (!after.isFile || after.uid !== uid || (after.mode & 0o777) !== 0o600) {
        throw new StoreSecurityError("Private SQLite file permissions could not be established.");
      }
      return after;
    } finally {
      safelyClose(this.syscalls, descriptor);
    }
  }

  private assertRetainedDirectoryChain(): void {
    for (let index = 1; index < this.directoryChain.length; index += 1) {
      const parent = this.directoryChain[index - 1];
      const retained = this.directoryChain[index];
      if (!parent || !retained || retained.component === undefined) {
        throw new StoreSecurityError("The retained state-directory chain is malformed.");
      }
      let reopened: number;
      try {
        reopened = this.syscalls.open(
          descriptorPath(parent.descriptor, retained.component),
          fileConstants.O_RDONLY | fileConstants.O_DIRECTORY | fileConstants.O_NOFOLLOW,
        );
      } catch {
        throw new StoreSecurityError("A canonical state directory component is unavailable.");
      }
      try {
        const expected = this.syscalls.fstat(retained.descriptor);
        const actual = this.syscalls.fstat(reopened);
        if (
          expected.device === undefined ||
          expected.inode === undefined ||
          actual.device !== expected.device ||
          actual.inode !== expected.inode
        ) {
          throw new StoreSecurityError("A canonical state directory identity changed.");
        }
      } finally {
        safelyClose(this.syscalls, reopened);
      }
    }
  }

  private readSizes(): FileSizes {
    const size = (suffix: string, create = false): number =>
      this.verifyFile(`${this.databaseFileName}${suffix}`, create)?.size ?? 0;
    return {
      database: size("", true),
      wal: size("-wal"),
      shm: size("-shm"),
      journal: size("-journal"),
    };
  }

  private exceedsCeiling(sizes: FileSizes, maximumDatabaseBytes: number): boolean {
    const walCeiling = Math.min(8 * 1024 * 1024, Math.max(256 * 1024, maximumDatabaseBytes / 4));
    const shmCeiling = Math.min(2 * 1024 * 1024, Math.max(64 * 1024, maximumDatabaseBytes / 32));
    const aggregateCeiling = maximumDatabaseBytes + walCeiling + shmCeiling;
    return (
      sizes.database > maximumDatabaseBytes ||
      sizes.wal > walCeiling ||
      sizes.shm > shmCeiling ||
      sizes.journal > walCeiling ||
      sizes.database + sizes.wal + sizes.shm + sizes.journal > aggregateCeiling
    );
  }

  private assertOpen(): void {
    if (this.isClosed) throw new StoreSecurityError("The private state descriptor is closed.");
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
  const directoryChain: Array<{ readonly descriptor: number; readonly component?: string }> = [
    { descriptor: current },
  ];
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
