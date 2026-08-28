import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

type BunFfi = typeof import("bun:ffi");

export interface LinuxLibcSymbols {
  readonly __errno_location: () => unknown;
  readonly openat: (parent: number, name: Uint8Array, flags: number, mode: number) => number;
  readonly mkdirat: (parent: number, name: Uint8Array, mode: number) => number;
  readonly linkat: (
    sourceParent: number,
    source: Uint8Array,
    destinationParent: number,
    destination: Uint8Array,
    flags: number,
  ) => number;
  readonly unlinkat: (parent: number, name: Uint8Array, flags: number) => number;
  readonly fstatfs: (descriptor: number, output: Uint8Array) => number;
  readonly renameat2: (
    sourceParent: number,
    source: Uint8Array,
    destinationParent: number,
    destination: Uint8Array,
    flags: number,
  ) => number;
}

export interface LinuxLibc {
  readonly symbols: LinuxLibcSymbols;
}

type LinuxRenameAt2Syscall = (
  number: number,
  sourceParent: number,
  source: Uint8Array,
  destinationParent: number,
  destination: Uint8Array,
  flags: number,
) => number | bigint;

const require = createRequire(import.meta.url);

export function linuxRenameAt2SyscallNumber(architecture: string): number | undefined {
  if (architecture === "x64") return 316;
  if (architecture === "arm64") return 276;
  return undefined;
}

export function createLinuxRenameAt2Fallback(
  syscall: LinuxRenameAt2Syscall,
  architecture: string,
): LinuxLibcSymbols["renameat2"] | undefined {
  const number = linuxRenameAt2SyscallNumber(architecture);
  if (number === undefined) return undefined;
  return (sourceParent, source, destinationParent, destination, flags) =>
    Number(syscall(number, sourceParent, source, destinationParent, destination, flags));
}

/** Reviewed x64 locations plus uncertified ARM64 candidates retained for possible future scope. */
export function linuxLibcCandidates(architecture: string): readonly string[] {
  if (architecture === "x64") {
    return [
      "/lib/x86_64-linux-gnu/libc.so.6",
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
      "/lib64/libc.so.6",
      "/lib/libc.musl-x86_64.so.1",
      "/lib/ld-musl-x86_64.so.1",
    ];
  }
  if (architecture === "arm64") {
    return [
      "/lib/aarch64-linux-gnu/libc.so.6",
      "/usr/lib/aarch64-linux-gnu/libc.so.6",
      "/lib64/libc.so.6",
      "/lib/libc.musl-aarch64.so.1",
      "/lib/ld-musl-aarch64.so.1",
    ];
  }
  return [];
}

function safelyClose(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Trust validation is fail-closed; cleanup must not replace its result.
  }
}

function openTrustedLibc(candidate: string): number | undefined {
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    return undefined;
  }
  const components = canonical.slice(1).split("/");
  if (!canonical.startsWith("/") || components.some((component) => component.length === 0)) {
    return undefined;
  }
  let parent: number | undefined;
  try {
    parent = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const root = fstatSync(parent);
    if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o022) !== 0) return undefined;
    for (const component of components.slice(0, -1)) {
      const next = openSync(
        `/proc/self/fd/${parent}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      safelyClose(parent);
      parent = next;
      const value = fstatSync(parent);
      if (!value.isDirectory() || value.uid !== 0 || (value.mode & 0o022) !== 0) return undefined;
    }
    // The non-empty component validation above establishes this array invariant.
    const name = components.at(-1) as string;
    const library = openSync(
      `/proc/self/fd/${parent}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const value = fstatSync(library);
    if (!value.isFile() || value.uid !== 0 || (value.mode & 0o022) !== 0 || value.nlink < 1) {
      safelyClose(library);
      return undefined;
    }
    return library;
  } catch {
    return undefined;
  } finally {
    if (parent !== undefined) safelyClose(parent);
  }
}

function openFirstTrustedLibc(architecture: string): number | undefined {
  for (const candidate of linuxLibcCandidates(architecture)) {
    const descriptor = openTrustedLibc(candidate);
    if (descriptor !== undefined) return descriptor;
  }
  return undefined;
}

/** Loads libc only when secure export is configured or invoked. */
export function loadLinuxLibc(
  platform: NodeJS.Platform,
  architecture = process.arch,
): LinuxLibc | undefined {
  if (platform !== "linux") return undefined;
  const descriptor = openFirstTrustedLibc(architecture);
  if (descriptor === undefined) return undefined;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as BunFfi;
    const trustedDescriptorPath = `/proc/self/fd/${descriptor}`;
    const base = dlopen(trustedDescriptorPath, {
      __errno_location: { args: [], returns: FFIType.ptr },
      openat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      linkat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32],
        returns: FFIType.i32,
      },
      unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      fstatfs: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      syscall: {
        args: [
          FFIType.i64,
          FFIType.i32,
          FFIType.cstring,
          FFIType.i32,
          FFIType.cstring,
          FFIType.u32,
        ],
        returns: FFIType.i64,
      },
    });

    let renameat2: LinuxLibcSymbols["renameat2"] | undefined;
    try {
      const direct = dlopen(trustedDescriptorPath, {
        renameat2: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
          returns: FFIType.i32,
        },
      });
      renameat2 = direct.symbols.renameat2 as LinuxLibcSymbols["renameat2"];
    } catch {
      renameat2 = createLinuxRenameAt2Fallback(
        base.symbols.syscall as LinuxRenameAt2Syscall,
        architecture,
      );
    }
    if (!renameat2) return undefined;
    return {
      symbols: {
        ...(base.symbols as Omit<LinuxLibcSymbols, "renameat2">),
        renameat2,
      },
    };
  } catch {
    return undefined;
  } finally {
    safelyClose(descriptor);
  }
}
