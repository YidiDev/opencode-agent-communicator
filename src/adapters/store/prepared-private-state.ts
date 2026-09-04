import { constants as fileConstants } from "node:fs";

import { descriptorPath, errorCode, safelyClose } from "./linux-path-operations";
import { type LinuxFileStat, type LinuxPathSyscalls, StoreSecurityError } from "./store-types";

interface FileSizes {
  readonly database: number;
  readonly wal: number;
  readonly shm: number;
  readonly journal: number;
}

export interface RetainedDirectory {
  readonly descriptor: number;
  readonly component?: string;
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
    private readonly directoryChain: readonly RetainedDirectory[],
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
      } catch (cause: unknown) {
        throw new StoreSecurityError(
          "SQLite growth could not be checkpointed safely.",
          cause instanceof Error ? { cause } : undefined,
        );
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
