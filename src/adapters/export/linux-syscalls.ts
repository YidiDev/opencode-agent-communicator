import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

type BunFfi = typeof import("bun:ffi");

interface LinuxLibcSymbols {
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

type LoadedLinuxLibc = LinuxLibc | undefined;

export const linuxFlags = Object.freeze({
  atEmptyPath: 0x1000,
  oCloexec: 0x8_0000,
  // Reviewed from Linux asm-generic/fcntl.h. O_PATH permits metadata inspection without
  // opening a FIFO/device for I/O; O_NOFOLLOW makes the descriptor identify a final symlink.
  oPath: 0x20_0000,
  oTmpfile: 0x40_0000 | 0x1_0000,
  renameNoReplace: 1,
  renameExchange: 2,
});

export function linuxMountId(descriptor: number): string {
  let value: string;
  try {
    value = readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8");
  } catch {
    throw new LinuxSyscallError("mount-id", 38);
  }
  const matches = [...value.matchAll(/^mnt_id:\s*([0-9]+)$/gm)];
  const mountId = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (mountId === undefined) throw new LinuxSyscallError("mount-id", 38);
  return mountId;
}

export class LinuxSyscallError extends Error {
  override readonly name = "LinuxSyscallError";
  constructor(
    readonly operation: string,
    readonly errno: number,
  ) {
    super(`Linux syscall ${operation} failed.`);
  }
}

function cString(value: string): Uint8Array {
  if (value.includes("\0")) throw new LinuxSyscallError("argument", 22);
  return new TextEncoder().encode(`${value}\0`);
}

export function createLinuxSyscallBindings(library: LoadedLinuxLibc) {
  function errno(): number {
    const pointer = library?.symbols.__errno_location();
    if (!pointer) return 38;
    const { toArrayBuffer } = require("bun:ffi") as BunFfi;
    return new Int32Array(toArrayBuffer(pointer as never, 0, 4))[0] ?? 38;
  }

  function result(operation: string, value: number): number {
    if (value === -1) throw new LinuxSyscallError(operation, errno());
    return value;
  }

  function symbols(): LinuxLibcSymbols {
    if (!library) throw new LinuxSyscallError("platform", 38);
    return library.symbols;
  }

  return Object.freeze({
    assertAvailable(): void {
      symbols();
    },
    openAt(parent: number, name: string, flags: number, mode = 0): number {
      return result("openat", symbols().openat(parent, cString(name), flags, mode));
    },
    mkdirAt(parent: number, name: string, mode: number): void {
      result("mkdirat", symbols().mkdirat(parent, cString(name), mode));
    },
    linkAtEmpty(source: number, parent: number, name: string): void {
      result(
        "linkat",
        symbols().linkat(source, cString(""), parent, cString(name), linuxFlags.atEmptyPath),
      );
    },
    unlinkAt(parent: number, name: string): void {
      result("unlinkat", symbols().unlinkat(parent, cString(name), 0));
    },
    statFsType(descriptor: number): bigint {
      // Linux x86_64/aarch64 struct statfs is 120 bytes; ARM64 remains uncertified package scope.
      if (process.arch !== "x64" && process.arch !== "arm64") {
        throw new LinuxSyscallError("fstatfs-architecture", 38);
      }
      const output = new Uint8Array(120);
      result("fstatfs", symbols().fstatfs(descriptor, output));
      return new DataView(output.buffer).getBigInt64(0, true);
    },
    renameAt2Between(
      sourceParent: number,
      source: string,
      destinationParent: number,
      destination: string,
      flags: number,
    ): void {
      result(
        "renameat2",
        symbols().renameat2(
          sourceParent,
          cString(source),
          destinationParent,
          cString(destination),
          flags,
        ),
      );
    },
  });
}

let productionBindings: ReturnType<typeof createLinuxSyscallBindings> | undefined;

function bindings(): ReturnType<typeof createLinuxSyscallBindings> {
  productionBindings ??= createLinuxSyscallBindings(loadLinuxLibc(process.platform));
  return productionBindings;
}

export function assertLinuxSyscallsAvailable(): void {
  bindings().assertAvailable();
}

export function openAt(parent: number, name: string, flags: number, mode = 0): number {
  return bindings().openAt(parent, name, flags, mode);
}

export function mkdirAt(parent: number, name: string, mode: number): void {
  bindings().mkdirAt(parent, name, mode);
}

export function linkAtEmpty(source: number, parent: number, name: string): void {
  bindings().linkAtEmpty(source, parent, name);
}

export function unlinkAt(parent: number, name: string): void {
  bindings().unlinkAt(parent, name);
}

export function statFsType(descriptor: number): bigint {
  return bindings().statFsType(descriptor);
}

export function renameAt2(
  parent: number,
  source: string,
  destination: string,
  flags: number,
): void {
  bindings().renameAt2Between(parent, source, parent, destination, flags);
}

export function renameAt2Between(
  sourceParent: number,
  source: string,
  destinationParent: number,
  destination: string,
  flags: number,
): void {
  bindings().renameAt2Between(sourceParent, source, destinationParent, destination, flags);
}
