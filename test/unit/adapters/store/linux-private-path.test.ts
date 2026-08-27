import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  constants as fileConstants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type LinuxPathSyscalls,
  nodeLinuxPathSyscalls,
  preparePrivateStatePath,
  rejectedLinuxFileSystemMagic,
} from "../../../../src/adapters/store/linux-private-path";
import { StoreSecurityError } from "../../../../src/adapters/store/store-types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "private-state-unit-"));
  roots.push(value);
  return value;
}

function syscalls(overrides: Partial<LinuxPathSyscalls>): LinuxPathSyscalls {
  return { ...nodeLinuxPathSyscalls, ...overrides };
}

describe("descriptor-verified Linux state preparation", () => {
  test("retains the complete descriptor chain and rejects an intermediate replacement", () => {
    const base = root();
    const intermediate = join(base, "intermediate");
    const moved = join(base, "moved");
    mkdirSync(intermediate, { mode: 0o700 });
    const openDescriptors = new Set<number>();
    const calls = syscalls({
      open: (path, flags, mode) => {
        const descriptor = nodeLinuxPathSyscalls.open(path, flags, mode);
        openDescriptors.add(descriptor);
        return descriptor;
      },
      close: (descriptor) => {
        nodeLinuxPathSyscalls.close(descriptor);
        openDescriptors.delete(descriptor);
      },
    });
    const prepared = preparePrivateStatePath(join(intermediate, "state"), "db.sqlite3", {
      syscalls: calls,
    });
    expect(openDescriptors.size).toBeGreaterThan(1);
    renameSync(intermediate, moved);
    mkdirSync(intermediate, { mode: 0o700 });
    expect(() => prepared.verifySqliteFiles()).toThrow("canonical state directory");
    prepared.close();
    expect(openDescriptors.size).toBe(0);
  });

  test("fails closed when a canonical parent is swapped during preparation", () => {
    const base = root();
    const parent = join(base, "parent");
    const moved = join(base, "moved");
    const outside = join(base, "outside");
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    let swapped = false;
    const calls = syscalls({
      open: (path, flags, mode) => {
        if (!swapped && path.startsWith("/proc/self/fd/") && path.endsWith("/state")) {
          swapped = true;
          renameSync(parent, moved);
          symlinkSync(outside, parent);
        }
        return nodeLinuxPathSyscalls.open(path, flags, mode);
      },
    });
    expect(() =>
      preparePrivateStatePath(join(parent, "state"), "db.sqlite3", {
        syscalls: calls,
      }),
    ).toThrow("canonical state directory");
    expect(swapped).toBeTrue();
    expect(existsSync(join(moved, "state", "db.sqlite3"))).toBeFalse();
    expect(existsSync(join(outside, "state", "db.sqlite3"))).toBeFalse();
  });

  test("fails closed when the canonical pathname is swapped after preparation", () => {
    const base = root();
    const state = join(base, "state");
    const moved = join(base, "moved");
    const replacement = join(base, "replacement");
    let armed = false;
    let swapped = false;
    const prepared = preparePrivateStatePath(state, "db.sqlite3", {
      syscalls: syscalls({
        open: (path, flags, mode) => {
          if (armed && !swapped && path.startsWith("/proc/self/fd/") && path.endsWith("/state")) {
            swapped = true;
            renameSync(state, moved);
            mkdirSync(replacement, { mode: 0o700 });
            symlinkSync(replacement, state);
            symlinkSync("attacker", join(replacement, "db.sqlite3-wal"));
          }
          return nodeLinuxPathSyscalls.open(path, flags, mode);
        },
      }),
    });
    armed = true;
    expect(() => prepared.verifySqliteFiles()).toThrow("canonical state directory");
    expect(swapped).toBeTrue();
    expect(existsSync(join(moved, "db.sqlite3"))).toBeTrue();
    prepared.close();
  });
});

describe("Linux private state input and lifecycle validation", () => {
  test("rejects a group-writable existing canonical ancestor but permits private roots under /tmp", () => {
    const base = root();
    const shared = join(base, "shared");
    mkdirSync(shared, { mode: 0o770 });
    chmodSync(shared, 0o770);
    expect(() => preparePrivateStatePath(join(shared, "state"), "db.sqlite3")).toThrow(
      "writable canonical ancestor",
    );

    const prepared = preparePrivateStatePath(join(root(), "state"), "db.sqlite3");
    prepared.close();
  });

  test("rejects malformed filenames, relative roots, and an unavailable root descriptor", () => {
    const base = root();
    expect(() => preparePrivateStatePath(join(base, "state"), "bad/name")).toThrow(
      StoreSecurityError,
    );
    expect(() => preparePrivateStatePath("relative/state", "db.sqlite3")).toThrow(
      StoreSecurityError,
    );
    expect(() =>
      preparePrivateStatePath(join(base, "root-fault"), "db.sqlite3", {
        syscalls: syscalls({
          open: (path, flags, mode) => {
            if (path === "/") throw new Error("root unavailable");
            return nodeLinuxPathSyscalls.open(path, flags, mode);
          },
        }),
      }),
    ).toThrow(StoreSecurityError);
  });

  test("sanitizes component creation and reopen failures", () => {
    for (const stage of ["mkdir", "reopen"] as const) {
      const base = root();
      const state = join(base, `state-${stage}`);
      let missingObserved = false;
      expect(() =>
        preparePrivateStatePath(state, "db.sqlite3", {
          syscalls: syscalls({
            open: (path, flags, mode) => {
              if (path.endsWith(`/state-${stage}`)) {
                if (!missingObserved) {
                  missingObserved = true;
                  throw Object.assign(new Error("missing"), { code: "ENOENT" });
                }
                if (stage === "reopen") throw new Error("reopen refused");
              }
              return nodeLinuxPathSyscalls.open(path, flags, mode);
            },
            mkdir: (path, mode) => {
              if (stage === "mkdir" && path.endsWith("/state-mkdir")) {
                throw Object.assign(new Error("mkdir refused"), { code: "EACCES" });
              }
              nodeLinuxPathSyscalls.mkdir(path, mode);
            },
          }),
        }),
      ).toThrow(StoreSecurityError);
    }
  });

  test("rejects unsafe existing file mode and failed exclusive file creation", () => {
    const existingBase = root();
    const existingState = join(existingBase, "state");
    mkdirSync(existingState, { mode: 0o700 });
    writeFileSync(join(existingState, "db.sqlite3"), "", { mode: 0o644 });
    chmodSync(join(existingState, "db.sqlite3"), 0o644);
    expect(() => preparePrivateStatePath(existingState, "db.sqlite3")).toThrow(StoreSecurityError);

    const createBase = root();
    let firstDatabaseOpen = true;
    expect(() =>
      preparePrivateStatePath(join(createBase, "state"), "db.sqlite3", {
        syscalls: syscalls({
          open: (path, flags, mode) => {
            if (path.endsWith("/db.sqlite3")) {
              if (firstDatabaseOpen) {
                firstDatabaseOpen = false;
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
              }
              throw new Error("exclusive create refused");
            }
            return nodeLinuxPathSyscalls.open(path, flags, mode);
          },
        }),
      }),
    ).toThrow(StoreSecurityError);
  });

  test("supports idempotent close and explicit disposal", () => {
    const prepared = preparePrivateStatePath(join(root(), "state"), "db.sqlite3");
    prepared.close();
    prepared.close();
    const disposable = preparePrivateStatePath(join(root(), "state"), "db.sqlite3");
    disposable[Symbol.dispose]();
    expect(() => disposable.verifySqliteFiles()).toThrow(StoreSecurityError);
  });

  test("rejects root, non-normal paths, unsafe existing targets, and symlink components", () => {
    expect(() => preparePrivateStatePath("/", "db.sqlite3")).toThrow(StoreSecurityError);
    expect(() => preparePrivateStatePath("/tmp/../tmp/state", "db.sqlite3")).toThrow(
      StoreSecurityError,
    );
    expect(() => preparePrivateStatePath(tmpdir(), "db.sqlite3")).toThrow(StoreSecurityError);
    const base = root();
    const target = join(base, "target");
    mkdirSync(target);
    symlinkSync(target, join(base, "link"));
    expect(() => preparePrivateStatePath(join(base, "link", "state"), "db.sqlite3")).toThrow(
      StoreSecurityError,
    );
  });
});

describe("Linux private state file integrity validation", () => {
  test("rejects an injected sidecar swap relative to the retained final descriptor", () => {
    const base = root();
    const state = join(base, "state");
    let armed = false;
    let swapped = false;
    const prepared = preparePrivateStatePath(state, "db.sqlite3", {
      syscalls: syscalls({
        open: (path, flags, mode) => {
          if (
            armed &&
            !swapped &&
            path.startsWith("/proc/self/fd/") &&
            path.endsWith("db.sqlite3-wal")
          ) {
            swapped = true;
            symlinkSync("attacker", join(state, "db.sqlite3-wal"));
          }
          return nodeLinuxPathSyscalls.open(path, flags, mode);
        },
      }),
    });
    armed = true;
    expect(() => prepared.verifySqliteFiles()).toThrow(StoreSecurityError);
    expect(swapped).toBeTrue();
    prepared.close();
  });

  test("rejects a sticky/shared final directory before any fchmod", () => {
    for (const mode of [0o1777, 0o0770, 0o0702]) {
      const base = root();
      const state = join(base, `shared-${mode.toString(8)}`);
      mkdirSync(state, { mode });
      chmodSync(state, mode);
      let chmodCalls = 0;
      expect(() =>
        preparePrivateStatePath(state, "db.sqlite3", {
          syscalls: syscalls({
            fchmod: (descriptor, nextMode) => {
              chmodCalls += 1;
              nodeLinuxPathSyscalls.fchmod(descriptor, nextMode);
            },
          }),
        }),
      ).toThrow(StoreSecurityError);
      expect(chmodCalls).toBe(0);
      expect(chmodSync(state, mode)).toBeUndefined();
    }
  });

  test("rejects final database symlinks, FIFOs, device-like stats, and preplaced sidecars", () => {
    for (const kind of ["symlink", "fifo", "device", "sidecar"] as const) {
      const base = root();
      const state = join(base, "state");
      mkdirSync(state, { mode: 0o700 });
      const database = join(state, "db.sqlite3");
      let calls: LinuxPathSyscalls | undefined;
      if (kind === "symlink") symlinkSync("target", database);
      if (kind === "fifo") {
        const result = spawnSync("mkfifo", [database]);
        if (result.status !== 0) throw new Error("mkfifo fixture failed");
      }
      if (kind === "sidecar") symlinkSync("target", `${database}-wal`);
      if (kind === "device") {
        const databaseDescriptors = new Set<number>();
        calls = syscalls({
          open: (path, flags, mode) => {
            const descriptor = nodeLinuxPathSyscalls.open(path, flags, mode);
            if (path.endsWith("/db.sqlite3")) databaseDescriptors.add(descriptor);
            return descriptor;
          },
          fstat: (descriptor) => {
            const value = nodeLinuxPathSyscalls.fstat(descriptor);
            return databaseDescriptors.has(descriptor) ? { ...value, isFile: false } : value;
          },
        });
      }
      expect(() =>
        preparePrivateStatePath(state, "db.sqlite3", calls ? { syscalls: calls } : {}),
      ).toThrow(StoreSecurityError);
    }
  });

  test("rejects a preplaced hard-linked database file", () => {
    const base = root();
    const state = join(base, "state");
    mkdirSync(state, { mode: 0o700 });
    const source = join(base, "source");
    nodeLinuxPathSyscalls.close(
      nodeLinuxPathSyscalls.open(source, fileConstants.O_RDWR | fileConstants.O_CREAT, 0o600),
    );
    linkSync(source, join(state, "db.sqlite3"));
    expect(() => preparePrivateStatePath(state, "db.sqlite3")).toThrow(StoreSecurityError);
  });

  test("fails closed on injected UID, fchmod, and post-fchmod mode failures", () => {
    const uidBase = root();
    expect(() =>
      preparePrivateStatePath(join(uidBase, "state"), "db.sqlite3", {
        syscalls: syscalls({
          fstat: (descriptor) => {
            const value = nodeLinuxPathSyscalls.fstat(descriptor);
            return { ...value, uid: value.uid + 1 };
          },
        }),
      }),
    ).toThrow(StoreSecurityError);

    const chmodBase = root();
    expect(() =>
      preparePrivateStatePath(join(chmodBase, "state"), "db.sqlite3", {
        syscalls: syscalls({
          fchmod: () => {
            throw new Error("injected chmod refusal");
          },
        }),
      }),
    ).toThrow(StoreSecurityError);

    const modeBase = root();
    const state = join(modeBase, "state");
    mkdirSync(state);
    chmodSync(state, 0o755);
    expect(() =>
      preparePrivateStatePath(state, "db.sqlite3", {
        syscalls: syscalls({ fchmod: () => undefined }),
      }),
    ).toThrow(StoreSecurityError);
  });
});

describe("Linux filesystem and capacity validation", () => {
  test("rejects every shared-filesystem magic and FUSE unless explicitly allowed", () => {
    expect(rejectedLinuxFileSystemMagic).toEqual(
      expect.arrayContaining([0x4750_4653n, 0x1983_0326n, 0xaad7_aaean, 0x2003_0528n]),
    );
    for (const type of rejectedLinuxFileSystemMagic) {
      const base = root();
      expect(() =>
        preparePrivateStatePath(join(base, "state"), "db.sqlite3", {
          syscalls: syscalls({ statfsType: () => type }),
        }),
      ).toThrow(StoreSecurityError);
    }
    const fuseMagic = 0x6573_5546n;
    const rejectedBase = root();
    expect(() =>
      preparePrivateStatePath(join(rejectedBase, "state"), "db.sqlite3", {
        syscalls: syscalls({ statfsType: () => fuseMagic }),
      }),
    ).toThrow(StoreSecurityError);
    const allowedBase = root();
    const prepared = preparePrivateStatePath(join(allowedBase, "state"), "db.sqlite3", {
      allowFuse: true,
      syscalls: syscalls({ statfsType: () => fuseMagic }),
    });
    prepared.close();
  });

  test("does not expose raw adapter paths in public security errors", () => {
    const base = root();
    const raw = join(base, "secret-parent", "state");
    let error: unknown;
    try {
      preparePrivateStatePath(raw, "db.sqlite3", {
        syscalls: syscalls({
          fstat: () => {
            throw new Error(`adapter failed at ${raw}`);
          },
        }),
      });
    } catch (cause: unknown) {
      error = cause;
    }
    expect(error).toBeInstanceOf(StoreSecurityError);
    expect(String(error)).not.toContain(raw);
  });

  test("checkpoints before an over-ceiling mutation and fails closed when checkpointing blocks", () => {
    const base = root();
    const descriptors = new Map<number, string>();
    let oversized = false;
    const calls = syscalls({
      open: (path, flags, mode) => {
        const descriptor = nodeLinuxPathSyscalls.open(path, flags, mode);
        descriptors.set(descriptor, path);
        return descriptor;
      },
      fstat: (descriptor) => {
        const value = nodeLinuxPathSyscalls.fstat(descriptor);
        return oversized && descriptors.get(descriptor)?.endsWith("/db.sqlite3")
          ? { ...value, size: 2_000_000 }
          : value;
      },
    });
    const prepared = preparePrivateStatePath(join(base, "state"), "db.sqlite3", {
      syscalls: calls,
    });
    oversized = true;
    let checkpoints = 0;
    expect(() =>
      prepared.assertMutationCapacity(1_000_000, () => {
        checkpoints += 1;
        throw new Error("busy checkpoint with /raw/path");
      }),
    ).toThrow("SQLite growth could not be checkpointed safely.");
    expect(checkpoints).toBe(1);
    prepared.assertMutationCapacity(1_000_000, () => {
      checkpoints += 1;
      oversized = false;
    });
    expect(checkpoints).toBe(2);
    prepared.close();
    expect(() => prepared.verifySqliteFiles()).toThrow(StoreSecurityError);
  });
});
