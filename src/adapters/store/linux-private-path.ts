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
  syscalls.fchmod(descriptor, 0o700);
  const after = syscalls.fstat(descriptor);
  if (!after.isDirectory || after.uid !== uid || (after.mode & 0o777) !== 0o700) {
    throw new StoreSecurityError("Private state-directory permissions could not be established.");
  }
}

function validateDirectoryPath(directory: string): string[] {
  if (process.platform !== "linux" || !isAbsolute(directory)) {
    throw new StoreSecurityError("The SQLite adapter requires Linux and an absolute state path.");
  }
  if (directory === "/" || directory.includes("\0") || normalize(directory) !== directory) {
    throw new StoreSecurityError("The configured state directory is an unsafe target.");
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
  try {
    syscalls.mkdir(path, 0o700);
  } catch (cause: unknown) {
    if (errorCode(cause) !== "EEXIST") {
      throw new StoreSecurityError("A state-path component could not be created safely.");
    }
  }
  try {
    return { descriptor: syscalls.open(path, flags), created: true };
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
  ) {
    this.canonicalDatabasePath = `${canonicalDirectory}/${databaseFileName}`;
    this.sqliteDatabasePath = descriptorPath(directoryDescriptor, databaseFileName);
  }

  verifySqliteFiles(): void {
    this.assertOpen();
    this.verifyFile(this.databaseFileName, true);
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      this.verifyFile(`${this.databaseFileName}${suffix}`, false);
    }
  }

  assertMutationCapacity(maximumDatabaseBytes: number, checkpoint: () => void): void {
    this.assertOpen();
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
    safelyClose(this.syscalls, this.directoryDescriptor);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private verifyFile(name: string, create: boolean): LinuxFileStat | undefined {
    const flags = fileConstants.O_RDWR | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK;
    let descriptor: number;
    try {
      descriptor = this.syscalls.open(
        descriptorPath(this.directoryDescriptor, name),
        create ? flags | fileConstants.O_CREAT : flags,
        0o600,
      );
    } catch (cause: unknown) {
      if (!create && errorCode(cause) === "ENOENT") return undefined;
      throw new StoreSecurityError("A SQLite state file could not be opened safely.");
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
      this.syscalls.fchmod(descriptor, 0o600);
      const after = this.syscalls.fstat(descriptor);
      if (!after.isFile || after.uid !== uid || (after.mode & 0o777) !== 0o600) {
        throw new StoreSecurityError("Private SQLite file permissions could not be established.");
      }
      return after;
    } finally {
      safelyClose(this.syscalls, descriptor);
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
  try {
    assertPrivateDirectory(syscalls, current, false);
    for (const [index, component] of components.entries()) {
      const child = openDirectoryComponent(syscalls, current, component);
      try {
        assertPrivateDirectory(
          syscalls,
          child.descriptor,
          child.created || index === components.length - 1,
        );
      } catch (cause: unknown) {
        safelyClose(syscalls, child.descriptor);
        throw cause;
      }
      safelyClose(syscalls, current);
      current = child.descriptor;
    }
    assertSupportedFileSystem(syscalls, current, options.allowFuse === true);
    const prepared = new PreparedPrivateState(current, fileName, directory, syscalls);
    prepared.verifySqliteFiles();
    return prepared;
  } catch (cause: unknown) {
    safelyClose(syscalls, current);
    if (cause instanceof StoreSecurityError) throw cause;
    throw new StoreSecurityError("The private state path could not be prepared safely.");
  }
}
