import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fileSystem from "node:fs";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  LinuxSyscallError,
  assertLinuxSyscallsAvailable,
  createLinuxRenameAt2Fallback,
  createLinuxSyscallBindings,
  linkAtEmpty,
  linuxFlags,
  linuxLibcCandidates,
  linuxMountId,
  linuxRenameAt2SyscallNumber,
  loadLinuxLibc,
  mkdirAt,
  openAt,
  renameAt2,
  renameAt2Between,
  statFsType,
  unlinkAt,
} = await import("../../../../src/adapters/export/linux-syscalls");

type Dlopen = typeof import("bun:ffi").dlopen;

const runtimeRequire = createRequire(import.meta.url);

function withDlopen<T>(replacement: Dlopen, action: () => T): T {
  const ffi = runtimeRequire("bun:ffi") as typeof import("bun:ffi");
  const original = ffi.dlopen;
  ffi.dlopen = replacement;
  try {
    return action();
  } finally {
    ffi.dlopen = original;
  }
}

function fakeLibrary(symbols: Readonly<Record<string, unknown>>): ReturnType<Dlopen> {
  return { symbols } as unknown as ReturnType<Dlopen>;
}

interface TrustedPathMetadata {
  readonly root?: { readonly directory: boolean; readonly uid: number; readonly mode: number };
  readonly parent?: { readonly directory: boolean; readonly uid: number; readonly mode: number };
  readonly library?: {
    readonly file: boolean;
    readonly uid: number;
    readonly mode: number;
    readonly links: number;
  };
}

function withTrustedPathMetadata<T>(metadata: TrustedPathMetadata, action: () => T): T {
  let nextDescriptor = 40;
  const opened = new Map<number, "root" | "parent" | "library">();
  const realpath = spyOn(fileSystem, "realpathSync").mockImplementation(
    (() => "/trusted/libc.so") as unknown as typeof fileSystem.realpathSync,
  );
  const open = spyOn(fileSystem, "openSync").mockImplementation(((path: fileSystem.PathLike) => {
    const descriptor = nextDescriptor++;
    const value = String(path);
    opened.set(
      descriptor,
      value === "/" ? "root" : value.endsWith("/libc.so") ? "library" : "parent",
    );
    return descriptor;
  }) as typeof fileSystem.openSync);
  const stat = spyOn(fileSystem, "fstatSync").mockImplementation(((descriptor: number) => {
    const role = opened.get(descriptor);
    if (role === "root" || role === "parent") {
      const value = metadata[role] ?? { directory: true, uid: 0, mode: 0o755 };
      return { isDirectory: () => value.directory, uid: value.uid, mode: value.mode };
    }
    const value = metadata.library ?? { file: true, uid: 0, mode: 0o755, links: 1 };
    return { isFile: () => value.file, uid: value.uid, mode: value.mode, nlink: value.links };
  }) as unknown as typeof fileSystem.fstatSync);
  const close = spyOn(fileSystem, "closeSync").mockImplementation(() => undefined);
  try {
    return action();
  } finally {
    close.mockRestore();
    stat.mockRestore();
    open.mockRestore();
    realpath.mockRestore();
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux libc loading", () => {
  test("loads the production libc candidates lazily and retains the resulting bindings", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `
          import { createRequire } from "node:module";
          const require = createRequire(import.meta.url);
          const ffi = require("bun:ffi");
          const original = ffi.dlopen;
          const candidates = [];
          ffi.dlopen = (library, symbols) => {
            candidates.push(library);
            return original(library, symbols);
          };
          const syscalls = await import("./src/adapters/export/linux-syscalls.ts");
          if (candidates.length !== 0) throw new Error("libc loaded during import");
          syscalls.assertLinuxSyscallsAvailable();
          syscalls.assertLinuxSyscallsAvailable();
          console.log(JSON.stringify(candidates));
        `,
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const candidates = JSON.parse(stdout) as string[];
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatch(/^\/proc\/self\/fd\/\d+$/);
    expect(candidates[1]).toBe(candidates[0]);
  });

  test("uses architecture-reviewed glibc and musl candidates, never loader search names", () => {
    expect(linuxLibcCandidates("x64")).toEqual(
      expect.arrayContaining(["/lib/x86_64-linux-gnu/libc.so.6", "/lib/libc.musl-x86_64.so.1"]),
    );
    expect(linuxLibcCandidates("arm64")).toEqual(
      expect.arrayContaining(["/lib/aarch64-linux-gnu/libc.so.6", "/lib/libc.musl-aarch64.so.1"]),
    );
    expect(linuxLibcCandidates("riscv64")).toEqual([]);
    for (const architecture of ["x64", "arm64"]) {
      expect(
        linuxLibcCandidates(architecture).every((candidate) => candidate.startsWith("/")),
      ).toBe(true);
      expect(linuxLibcCandidates(architecture)).not.toContain("libc.so.6");
    }
  });

  test("ignores hostile dynamic-loader search paths", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `
          const syscalls = await import("./src/adapters/export/linux-syscalls.ts");
          syscalls.assertLinuxSyscallsAvailable();
          const descriptor = syscalls.openAt(-100, "/dev/null", 0);
          if (descriptor < 0) throw new Error("trusted libc binding unavailable");
        `,
      ],
      cwd: process.cwd(),
      env: { ...process.env, LD_LIBRARY_PATH: join(tmpdir(), "hostile-libc-search") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      Bun.readableStreamToText(child.stderr),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("falls back to architecture-specific renameat2 syscalls", () => {
    expect(linuxRenameAt2SyscallNumber("x64")).toBe(316);
    expect(linuxRenameAt2SyscallNumber("arm64")).toBe(276);
    expect(linuxRenameAt2SyscallNumber("riscv64")).toBeUndefined();
    const calls: unknown[][] = [];
    let openCount = 0;
    const library = withDlopen(
      (() => {
        openCount += 1;
        if (openCount === 2) throw new Error("renameat2 symbol absent");
        return fakeLibrary({
          syscall: (...values: unknown[]) => {
            calls.push(values);
            return 7n;
          },
        });
      }) as Dlopen,
      () => loadLinuxLibc("linux", "x64"),
    );

    const source = new Uint8Array([1]);
    const destination = new Uint8Array([2]);
    expect(library?.symbols.renameat2(3, source, 4, destination, 5)).toBe(7);
    expect(calls).toEqual([[316, 3, source, 4, destination, 5]]);
  });

  test.each(["relative/libc.so", "/trusted//libc.so"])(
    "rejects a non-canonical resolved libc path: %s",
    (canonical) => {
      const realpath = spyOn(fileSystem, "realpathSync").mockImplementation(
        (() => canonical) as unknown as typeof fileSystem.realpathSync,
      );
      try {
        expect(loadLinuxLibc("linux", "x64")).toBeUndefined();
      } finally {
        realpath.mockRestore();
      }
    },
  );

  test("fails closed when a libc candidate cannot be resolved", () => {
    const realpath = spyOn(fileSystem, "realpathSync").mockImplementation((() => {
      throw new Error("candidate unavailable");
    }) as unknown as typeof fileSystem.realpathSync);
    try {
      expect(loadLinuxLibc("linux", "x64")).toBeUndefined();
    } finally {
      realpath.mockRestore();
    }
  });

  test("fails closed when the root trust descriptor cannot be opened", () => {
    const realpath = spyOn(fileSystem, "realpathSync").mockImplementation(
      (() => "/trusted/libc.so") as unknown as typeof fileSystem.realpathSync,
    );
    const open = spyOn(fileSystem, "openSync").mockImplementation(() => {
      throw new Error("descriptor unavailable");
    });
    try {
      expect(loadLinuxLibc("linux", "x64")).toBeUndefined();
    } finally {
      open.mockRestore();
      realpath.mockRestore();
    }
  });

  test.each([
    ["non-directory root", { root: { directory: false, uid: 0, mode: 0o755 } }],
    ["non-root-owned root", { root: { directory: true, uid: 1, mode: 0o755 } }],
    ["writable root", { root: { directory: true, uid: 0, mode: 0o777 } }],
    ["non-directory parent", { parent: { directory: false, uid: 0, mode: 0o755 } }],
    ["non-root-owned parent", { parent: { directory: true, uid: 1, mode: 0o755 } }],
    ["writable parent", { parent: { directory: true, uid: 0, mode: 0o777 } }],
    ["non-file library", { library: { file: false, uid: 0, mode: 0o755, links: 1 } }],
    ["non-root-owned library", { library: { file: true, uid: 1, mode: 0o755, links: 1 } }],
    ["writable library", { library: { file: true, uid: 0, mode: 0o777, links: 1 } }],
    ["unlinked library", { library: { file: true, uid: 0, mode: 0o755, links: 0 } }],
  ] as const)("fails closed for a %s", (_label, metadata) => {
    expect(withTrustedPathMetadata(metadata, () => loadLinuxLibc("linux", "x64"))).toBeUndefined();
  });
});

describe("Linux libc failure handling", () => {
  test("fails closed for unavailable libc, malformed rename symbols, and absent fallbacks", () => {
    expect(
      withDlopen(
        (() => {
          throw new Error("libc absent");
        }) as Dlopen,
        () => loadLinuxLibc("linux"),
      ),
    ).toBeUndefined();

    expect(createLinuxRenameAt2Fallback(() => 0, "riscv64")).toBeUndefined();

    let malformedOpenCount = 0;
    expect(
      withDlopen(
        (() => {
          malformedOpenCount += 1;
          return malformedOpenCount === 1
            ? fakeLibrary({ syscall: () => 0 })
            : fakeLibrary({ renameat2: undefined });
        }) as Dlopen,
        () => loadLinuxLibc("linux", "x64"),
      ),
    ).toBeUndefined();

    let unsupportedOpenCount = 0;
    expect(
      withDlopen(
        (() => {
          unsupportedOpenCount += 1;
          if (unsupportedOpenCount === 2) throw new Error("renameat2 symbol absent");
          return fakeLibrary({ syscall: () => 0 });
        }) as Dlopen,
        () => loadLinuxLibc("linux", "riscv64"),
      ),
    ).toBeUndefined();
  });

  test("reports fallback syscall failures through the public binding", () => {
    let openCount = 0;
    const library = withDlopen(
      (() => {
        openCount += 1;
        if (openCount === 2) throw new Error("renameat2 symbol absent");
        return fakeLibrary({
          __errno_location: () => null,
          syscall: () => -1n,
        });
      }) as Dlopen,
      () => loadLinuxLibc("linux", "x64"),
    );

    expect(() =>
      createLinuxSyscallBindings(library).renameAt2Between(3, "old", 3, "new", 1),
    ).toThrow(expect.objectContaining({ operation: "renameat2", errno: 38 }));
  });

  test("uses the generic errno when the runtime returns no errno bytes", () => {
    const ffi = runtimeRequire("bun:ffi") as typeof import("bun:ffi");
    const original = ffi.toArrayBuffer;
    ffi.toArrayBuffer = (() => new ArrayBuffer(0)) as typeof ffi.toArrayBuffer;
    try {
      const bindings = createLinuxSyscallBindings({
        symbols: { __errno_location: () => ({ address: 1 }), openat: () => -1 },
      } as never);
      expect(() => bindings.openAt(-1, "missing", constants.O_RDONLY)).toThrow(
        expect.objectContaining({ operation: "openat", errno: 38 }),
      );
    } finally {
      ffi.toArrayBuffer = original;
    }
  });
});

describe("Linux descriptor-relative export syscall bindings", () => {
  test("renames and unlinks only names relative to the retained parent descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "communicator-export-syscalls-"));
    roots.push(root);
    writeFileSync(join(root, "stage"), "private");
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      renameAt2(parent, "stage", "installed", linuxFlags.renameNoReplace);
      expect(existsSync(join(root, "stage"))).toBe(false);
      expect(existsSync(join(root, "installed"))).toBe(true);
      unlinkAt(parent, "installed");
      expect(existsSync(join(root, "installed"))).toBe(false);
      mkdirSync(join(root, "nested"), { mode: 0o700 });
      writeFileSync(join(root, "cross-stage"), "private");
      const nested = openSync(join(root, "nested"), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        renameAt2Between(parent, "cross-stage", nested, "installed", linuxFlags.renameNoReplace);
        expect(existsSync(join(root, "nested", "installed"))).toBe(true);
      } finally {
        closeSync(nested);
      }
    } finally {
      closeSync(parent);
    }
  });

  test("rejects embedded NUL before invoking libc", () => {
    expect(() => openAt(0, "unsafe\0name", constants.O_RDONLY)).toThrow(LinuxSyscallError);
  });

  test("creates directories and reports missing descriptor-relative names with native errno", () => {
    const root = mkdtempSync(join(tmpdir(), "communicator-export-syscalls-"));
    roots.push(root);
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      mkdirAt(parent, "nested", 0o700);
      expect(existsSync(join(root, "nested"))).toBe(true);
      expect(() => openAt(parent, "missing", constants.O_RDONLY)).toThrow(
        expect.objectContaining({ operation: "openat", errno: 2 }),
      );
      expect(typeof statFsType(parent)).toBe("bigint");
      expect(linuxMountId(parent)).toMatch(/^[0-9]+$/);
      expect(() => linkAtEmpty(-1, parent, "impossible")).toThrow(
        expect.objectContaining({ operation: "linkat" }),
      );
    } finally {
      closeSync(parent);
    }
    expect(() => linuxMountId(-1)).toThrow(
      expect.objectContaining({ operation: "mount-id", errno: 38 }),
    );
  });

  test("fails closed when libc or its errno pointer is unavailable", () => {
    expect(loadLinuxLibc("darwin")).toBeUndefined();
    const unavailable = createLinuxSyscallBindings(undefined);
    expect(() => unavailable.openAt(0, "name", constants.O_RDONLY)).toThrow(
      expect.objectContaining({ name: "LinuxSyscallError", operation: "platform", errno: 38 }),
    );

    const missingErrno = createLinuxSyscallBindings({
      symbols: {
        __errno_location: () => null,
        openat: () => -1,
      },
    } as never);
    expect(() => missingErrno.openAt(-1, "name", constants.O_RDONLY)).toThrow(
      expect.objectContaining({ name: "LinuxSyscallError", operation: "openat", errno: 38 }),
    );

    createLinuxSyscallBindings({ symbols: {} } as never).assertAvailable();
    expect(() => assertLinuxSyscallsAvailable()).not.toThrow();
  });

  test("fails closed before fstatfs on unsupported architectures", () => {
    const original = process.arch;
    Object.defineProperty(process, "arch", { configurable: true, value: "riscv64" });
    try {
      expect(() => statFsType(-1)).toThrow(
        expect.objectContaining({ operation: "fstatfs-architecture", errno: 38 }),
      );
    } finally {
      Object.defineProperty(process, "arch", { configurable: true, value: original });
    }
  });
});
