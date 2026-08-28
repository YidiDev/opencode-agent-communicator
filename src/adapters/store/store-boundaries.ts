import type { Database } from "bun:sqlite";

export interface LinuxFileStat {
  readonly device?: number;
  readonly inode?: number;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  readonly nlink: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

/** Narrow injectable boundary used by race and failure tests. */
export interface LinuxPathSyscalls {
  readonly open: (path: string, flags: number, mode?: number) => number;
  readonly close: (descriptor: number) => void;
  readonly mkdir: (path: string, mode: number) => void;
  readonly fstat: (descriptor: number) => LinuxFileStat;
  readonly fchmod: (descriptor: number, mode: number) => void;
  readonly statfsType: (descriptorPath: string) => bigint;
  readonly uid: () => number | undefined;
}

/** Minimal injectable boundary for deterministic database open/close failure tests. */
export interface SqliteDatabaseLifecycle {
  readonly open: (path: string, flags: number) => Database;
  readonly close: (database: Database) => void;
}
