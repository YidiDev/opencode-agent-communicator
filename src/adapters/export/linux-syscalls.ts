import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { type LinuxLibc, type LinuxLibcSymbols, loadLinuxLibc } from "./linux-libc";

export {
  createLinuxRenameAt2Fallback,
  type LinuxLibc,
  linuxLibcCandidates,
  linuxRenameAt2SyscallNumber,
  loadLinuxLibc,
} from "./linux-libc";

type BunFfi = typeof import("bun:ffi");

const require = createRequire(import.meta.url);

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
