import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as actualSyscalls from "../../../../src/adapters/export/linux-syscalls";

type OpenAt = typeof actualSyscalls.openAt;

const systemOpenAt = actualSyscalls.openAt;
const systemLinkAtEmpty = actualSyscalls.linkAtEmpty;
const systemMkdirAt = actualSyscalls.mkdirAt;
const systemMountId = actualSyscalls.linuxMountId;
const systemRenameAt2Between = actualSyscalls.renameAt2Between;
const systemStatFsType = actualSyscalls.statFsType;
const systemUnlinkAt = actualSyscalls.unlinkAt;
const openHandlers = new Map<number, OpenAt>();
const linkHandlers = new Map<number, typeof actualSyscalls.linkAtEmpty>();
const renameHandlers = new Map<number, typeof actualSyscalls.renameAt2Between>();
const unlinkHandlers = new Map<number, typeof actualSyscalls.unlinkAt>();
let openOverride: ((args: Parameters<OpenAt>) => number) | undefined;
let mkdirOverride: ((args: Parameters<typeof actualSyscalls.mkdirAt>) => void) | undefined;
let mountIdOverride: ((descriptor: number) => string) | undefined;
let statFsOverride: ((descriptor: number) => bigint) | undefined;

mock.module("../../../../src/adapters/export/linux-syscalls", () => ({
  ...actualSyscalls,
  openAt: (...args: Parameters<OpenAt>) =>
    openOverride?.(args) ?? (openHandlers.get(args[0]) ?? systemOpenAt)(...args),
  mkdirAt: (...args: Parameters<typeof actualSyscalls.mkdirAt>) =>
    mkdirOverride?.(args) ?? systemMkdirAt(...args),
  linuxMountId: (descriptor: number) => mountIdOverride?.(descriptor) ?? systemMountId(descriptor),
  statFsType: (descriptor: number) => statFsOverride?.(descriptor) ?? systemStatFsType(descriptor),
  linkAtEmpty: (...args: Parameters<typeof actualSyscalls.linkAtEmpty>) =>
    (linkHandlers.get(args[1]) ?? systemLinkAtEmpty)(...args),
  renameAt2Between: (...args: Parameters<typeof actualSyscalls.renameAt2Between>) =>
    (renameHandlers.get(args[0]) ?? systemRenameAt2Between)(...args),
  unlinkAt: (...args: Parameters<typeof actualSyscalls.unlinkAt>) =>
    (unlinkHandlers.get(args[0]) ?? systemUnlinkAt)(...args),
}));

const { ExportPathError, installLinuxExport } = await import(
  "../../../../src/adapters/export/linux-export-install"
);
const { LinuxExportRoot } = await import(
  "../../../../src/adapters/export/linux-export-destination"
);
const { cleanupStaleExportStages, exportStageMinimumAgeMs } = await import(
  "../../../../src/adapters/export/linux-export-stage-cleanup"
);

const roots: string[] = [];
const stageName = `.session-export-${"a".repeat(32)}.stage`;

function openDescriptorCount(): number {
  return readdirSync("/proc/self/fd").length;
}

function cleanupFixture(): { readonly root: string; readonly descriptor: number } {
  const root = mkdtempSync(join(tmpdir(), "communicator-stage-cleanup-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { root, descriptor: openSync(root, constants.O_RDONLY | constants.O_DIRECTORY) };
}

function privateStage(root: string): string {
  const path = join(root, stageName);
  writeFileSync(path, "transcript", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function syscallError(errno: number): actualSyscalls.LinuxSyscallError {
  return new actualSyscalls.LinuxSyscallError("fixture", errno);
}

function descriptors() {
  const root = mkdtempSync(join(tmpdir(), "communicator-export-install-"));
  roots.push(root);
  const temporaryPath = join(root, "temporary");
  const destinationPath = join(root, "destination");
  writeFileSync(temporaryPath, "new", { mode: 0o600 });
  writeFileSync(destinationPath, "old", { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  chmodSync(destinationPath, 0o600);
  const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  const temporary = openSync(temporaryPath, constants.O_RDONLY);
  const destination = openSync(destinationPath, constants.O_RDONLY);
  linkHandlers.set(parent, () => undefined);
  renameHandlers.set(parent, () => undefined);
  unlinkHandlers.set(parent, () => undefined);
  return {
    parent,
    temporary,
    destination,
    duplicate: (descriptor: number) => openSync(`/proc/self/fd/${descriptor}`, constants.O_RDONLY),
    close: () => {
      openHandlers.delete(parent);
      linkHandlers.delete(parent);
      renameHandlers.delete(parent);
      unlinkHandlers.delete(parent);
      closeSync(destination);
      closeSync(temporary);
      closeSync(parent);
    },
  };
}

function install(
  parent: number,
  temporary: number,
  shouldOverwrite: boolean,
  stagingParent = parent,
): void {
  installLinuxExport({
    parentDescriptor: parent,
    stagingParentDescriptor: stagingParent,
    temporaryDescriptor: temporary,
    destinationName: "result.json",
    stagingName: ".stage",
    shouldOverwrite,
  });
}

afterEach(() => {
  openOverride = undefined;
  mkdirOverride = undefined;
  mountIdOverride = undefined;
  statFsOverride = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux export destination fault boundaries", () => {
  function exportRoot(): { root: ReturnType<typeof LinuxExportRoot.open>; base: string } {
    const base = mkdtempSync(join(tmpdir(), "communicator-export-destination-unit-"));
    roots.push(base);
    chmodSync(base, 0o700);
    return { root: LinuxExportRoot.open(join(base, "exports")), base };
  }

  test("accepts an existing private root and rejects a missing intermediate root component", () => {
    const base = mkdtempSync(join(tmpdir(), "communicator-export-existing-unit-"));
    roots.push(base);
    chmodSync(base, 0o700);
    const path = join(base, "exports");
    mkdirSync(path, { mode: 0o700 });
    using root = LinuxExportRoot.open(path);
    expect(root).toBeInstanceOf(LinuxExportRoot);
    expect(() => LinuxExportRoot.open(join(base, "missing", "exports"))).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );
  });

  test("classifies nested directory creation and reopen races", () => {
    const first = exportRoot();
    using firstRoot = first.root;
    openOverride = (args) => {
      if (args[1] === "nested") throw syscallError(2);
      return systemOpenAt(...args);
    };
    mkdirOverride = () => {
      throw syscallError(5);
    };
    expect(() => firstRoot.createTemporary("nested/x", "a".repeat(32))).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );

    openOverride = undefined;
    mkdirOverride = undefined;
    const second = exportRoot();
    using secondRoot = second.root;
    openOverride = (args) => {
      if (args[1] === "nested") throw syscallError(2);
      return systemOpenAt(...args);
    };
    mkdirOverride = () => {
      throw syscallError(17);
    };
    expect(() => secondRoot.createTemporary("nested/x", "b".repeat(32))).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );
  });

  test("rejects unsupported anonymous temporary files and non-file descriptors", () => {
    const unsupported = exportRoot();
    using unsupportedRoot = unsupported.root;
    openOverride = (args) => {
      if ((args[2] & actualSyscalls.linuxFlags.oTmpfile) === actualSyscalls.linuxFlags.oTmpfile)
        throw syscallError(22);
      return systemOpenAt(...args);
    };
    expect(() => unsupportedRoot.createTemporary("x", "c".repeat(32))).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );

    openOverride = undefined;
    const malformed = exportRoot();
    using malformedRoot = malformed.root;
    openOverride = (args) => {
      if ((args[2] & actualSyscalls.linuxFlags.oTmpfile) === actualSyscalls.linuxFlags.oTmpfile) {
        return openSync(malformed.base, constants.O_RDONLY | constants.O_DIRECTORY);
      }
      return systemOpenAt(...args);
    };
    const descriptorsBefore = openDescriptorCount();
    expect(() => malformedRoot.createTemporary("x", "d".repeat(32))).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );
    expect(openDescriptorCount()).toBe(descriptorsBefore);
  });
});

describe("Linux export destination hostile descriptor boundaries", () => {
  function exportRoot(): { root: ReturnType<typeof LinuxExportRoot.open>; base: string } {
    const base = mkdtempSync(join(tmpdir(), "communicator-export-hostile-unit-"));
    roots.push(base);
    chmodSync(base, 0o700);
    return { root: LinuxExportRoot.open(join(base, "exports")), base };
  }

  test("rejects unsafe root descriptor shapes and filesystem identities", () => {
    for (const mode of ["file", "public"] as const) {
      const base = mkdtempSync(join(tmpdir(), "communicator-export-root-shape-"));
      roots.push(base);
      chmodSync(base, 0o700);
      const candidate = join(base, mode);
      if (mode === "file") writeFileSync(candidate, "x", { mode: 0o600 });
      else {
        mkdirSync(candidate, { mode: 0o755 });
        chmodSync(candidate, 0o755);
      }
      openOverride = (args) =>
        args[1] === "exports" ? openSync(candidate, constants.O_RDONLY) : systemOpenAt(...args);
      expect(() => LinuxExportRoot.open(join(base, "exports"))).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
      openOverride = undefined;
    }

    const rejected = exportRoot();
    rejected.root.close();
    statFsOverride = () => 0x0000_6969n;
    expect(() => LinuxExportRoot.open(join(rejected.base, "other"))).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );
    statFsOverride = () => {
      throw new Error("fstatfs failed");
    };
    expect(() => LinuxExportRoot.open(join(rejected.base, "unavailable"))).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
  });

  test("classifies invalid reopened parents and temporary syscall fallbacks", () => {
    const reopened = exportRoot();
    using reopenedRoot = reopened.root;
    let nestedOpens = 0;
    openOverride = (args) => {
      if (args[1] === "nested") {
        nestedOpens += 1;
        if (nestedOpens === 1) throw syscallError(2);
        return -1;
      }
      return systemOpenAt(...args);
    };
    expect(() => reopenedRoot.createTemporary("nested/x", "e".repeat(32))).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );

    for (const [errno, kind] of [
      [38, "unsafe_path"],
      [95, "unsafe_path"],
      [5, "storage_unavailable"],
    ] as const) {
      openOverride = undefined;
      const value = exportRoot();
      using root = value.root;
      openOverride = (args) => {
        if ((args[2] & actualSyscalls.linuxFlags.oTmpfile) === actualSyscalls.linuxFlags.oTmpfile)
          throw syscallError(errno);
        return systemOpenAt(...args);
      };
      expect(() => root.createTemporary("x", "f".repeat(32))).toThrow(
        expect.objectContaining({ kind }),
      );
    }
  });

  test("rejects a raced public nested directory and traverses a stable private one", () => {
    const raced = exportRoot();
    using racedRoot = raced.root;
    const publicDirectory = join(raced.base, "public");
    mkdirSync(publicDirectory, { mode: 0o777 });
    chmodSync(publicDirectory, 0o777);
    let opens = 0;
    openOverride = (args) => {
      if (args[1] === "nested") {
        opens += 1;
        if (opens === 1) throw syscallError(2);
        return openSync(publicDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
      }
      return systemOpenAt(...args);
    };
    const descriptorsBefore = openDescriptorCount();
    expect(() => racedRoot.createTemporary("nested/x", "2".repeat(32))).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );
    expect(openDescriptorCount()).toBe(descriptorsBefore);

    openOverride = undefined;
    const stable = exportRoot();
    using stableRoot = stable.root;
    const temporary = stableRoot.createTemporary("nested/x", "3".repeat(32));
    temporary.discard();
  });

  test("rejects a destination parent that crosses the configured root filesystem", () => {
    const value = exportRoot();
    using root = value.root;
    mountIdOverride = () => "different-mount";
    expect(() => root.createTemporary("nested/x", "4".repeat(32))).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );
  });

  test("discard is idempotent for an uninstalled anonymous temporary", () => {
    const value = exportRoot();
    using root = value.root;
    const temporary = root.createTemporary("x", "1".repeat(32));
    temporary.discard();
    temporary.discard();
  });
});

describe("Linux export inode installation", () => {
  test("verifies a no-replace link identifies the retained temporary inode", () => {
    const value = descriptors();
    try {
      openHandlers.set(value.parent, () => value.duplicate(value.temporary));
      install(value.parent, value.temporary, false);
    } finally {
      value.close();
    }
  });

  test("keeps create-if-absent overwrite on RENAME_NOREPLACE", () => {
    const value = descriptors();
    let opens = 0;
    const renameFlags: number[] = [];
    try {
      openHandlers.set(value.parent, () => {
        opens += 1;
        if (opens === 1) throw syscallError(2);
        return value.duplicate(value.temporary);
      });
      renameHandlers.set(
        value.parent,
        (_sourceParent, _source, _destinationParent, _destination, flags) => {
          renameFlags.push(flags);
        },
      );
      install(value.parent, value.temporary, true);
      expect(opens).toBe(2);
      expect(renameFlags).toEqual([actualSyscalls.linuxFlags.renameNoReplace]);
    } finally {
      value.close();
    }
  });

  test("atomically replaces only a stable private regular destination without exchange", () => {
    const value = descriptors();
    const observed = [value.destination, value.destination, value.temporary];
    const renameFlags: number[] = [];
    try {
      openHandlers.set(value.parent, () => value.duplicate(observed.shift() ?? value.temporary));
      renameHandlers.set(
        value.parent,
        (_sourceParent, _source, _destinationParent, _destination, flags) => {
          renameFlags.push(flags);
        },
      );
      install(value.parent, value.temporary, true);
      expect(observed).toEqual([]);
      expect(renameFlags).toEqual([0]);
    } finally {
      value.close();
    }
  });

  test("rejects a destination-name race before replacement", () => {
    const value = descriptors();
    const observed = [value.destination, value.temporary];
    let renames = 0;
    try {
      openHandlers.set(value.parent, () => value.duplicate(observed.shift() ?? value.temporary));
      renameHandlers.set(value.parent, () => {
        renames += 1;
      });
      expect(() => install(value.parent, value.temporary, true)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
      expect(renames).toBe(0);
    } finally {
      value.close();
    }
  });

  test("does not unlink a stage after successful replacement when verification becomes ambiguous", () => {
    const value = descriptors();
    const observed = [value.destination, value.destination];
    let unlinks = 0;
    try {
      openHandlers.set(value.parent, () => {
        const descriptor = observed.shift();
        if (descriptor === undefined) throw syscallError(5);
        return value.duplicate(descriptor);
      });
      unlinkHandlers.set(value.parent, () => {
        unlinks += 1;
      });
      expect(() => install(value.parent, value.temporary, true)).toThrow(
        expect.objectContaining({ kind: "native_outcome_unknown" }),
      );
      expect(unlinks).toBe(0);
    } finally {
      value.close();
    }
  });

  test("classifies no-replace link failures without exposing syscall details", () => {
    const value = descriptors();
    try {
      for (const [errno, kind] of [
        [17, "destination_exists"],
        [1, "unsafe_path"],
        [5, "storage_unavailable"],
      ] as const) {
        linkHandlers.set(value.parent, () => {
          throw syscallError(errno);
        });
        expect(() => install(value.parent, value.temporary, false)).toThrow(
          expect.objectContaining({ kind }),
        );
      }
    } finally {
      value.close();
    }
  });

  test("removes the stage when an overwrite race leaves no destination", () => {
    const value = descriptors();
    let unlinks = 0;
    try {
      openHandlers.set(value.parent, () => {
        throw syscallError(2);
      });
      renameHandlers.set(value.parent, () => {
        throw syscallError(17);
      });
      unlinkHandlers.set(value.parent, () => {
        unlinks += 1;
      });
      expect(() => install(value.parent, value.temporary, true)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
      expect(unlinks).toBe(1);
    } finally {
      value.close();
    }
  });

  test("rejects a non-regular overwrite destination before replacement", () => {
    const value = descriptors();
    try {
      openHandlers.set(value.parent, () => value.duplicate(value.parent));
      const descriptorsBefore = openDescriptorCount();
      expect(() => install(value.parent, value.temporary, true)).toThrow(ExportPathError);
      expect(openDescriptorCount()).toBe(descriptorsBefore);
    } finally {
      value.close();
    }
  });

  test("maps pre-effect replacement failure to storage unavailability after stage cleanup", () => {
    const value = descriptors();
    let unlinks = 0;
    try {
      openHandlers.set(value.parent, () => value.duplicate(value.destination));
      renameHandlers.set(value.parent, () => {
        throw syscallError(5);
      });
      unlinkHandlers.set(value.parent, () => {
        unlinks += 1;
      });
      expect(() => install(value.parent, value.temporary, true)).toThrow(
        expect.objectContaining({ kind: "storage_unavailable" }),
      );
      expect(unlinks).toBe(1);
    } finally {
      value.close();
    }
  });
});

describe("Linux export inode installation failure classification", () => {
  test("flushes distinct staging and destination parents after atomic replacement", () => {
    const value = descriptors();
    const stagingParent = value.duplicate(value.parent);
    const observed = [value.destination, value.destination, value.temporary];
    try {
      linkHandlers.set(stagingParent, () => undefined);
      renameHandlers.set(stagingParent, () => undefined);
      openHandlers.set(value.parent, () => value.duplicate(observed.shift() ?? value.temporary));
      install(value.parent, value.temporary, true, stagingParent);
      expect(observed).toEqual([]);
    } finally {
      linkHandlers.delete(stagingParent);
      renameHandlers.delete(stagingParent);
      closeSync(stagingParent);
      value.close();
    }
  });

  test("reports unknown when staging-link durability cannot be proved", () => {
    const value = descriptors();
    const stagingParent = value.duplicate(value.parent);
    try {
      linkHandlers.set(stagingParent, () => closeSync(stagingParent));
      expect(() => install(value.parent, value.temporary, true, stagingParent)).toThrow(
        expect.objectContaining({ kind: "native_outcome_unknown" }),
      );
    } finally {
      linkHandlers.delete(stagingParent);
      value.close();
    }
  });

  test("fails closed when no-replace verification resolves to a different inode", () => {
    const value = descriptors();
    try {
      openHandlers.set(value.parent, () => value.duplicate(value.destination));
      expect(() => install(value.parent, value.temporary, false)).toThrow(
        expect.objectContaining({ kind: "native_outcome_unknown" }),
      );
    } finally {
      value.close();
    }
  });

  test("classifies staging link capability and storage failures", () => {
    const value = descriptors();
    try {
      for (const [errno, kind] of [
        [1, "unsafe_path"],
        [5, "storage_unavailable"],
      ] as const) {
        linkHandlers.set(value.parent, () => {
          throw syscallError(errno);
        });
        expect(() => install(value.parent, value.temporary, true)).toThrow(
          expect.objectContaining({ kind }),
        );
      }
    } finally {
      value.close();
    }
  });

  test("maps destination lookup and no-replace rename faults without replacing", () => {
    const lookup = descriptors();
    try {
      openHandlers.set(lookup.parent, () => {
        throw syscallError(13);
      });
      expect(() => install(lookup.parent, lookup.temporary, true)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
    } finally {
      lookup.close();
    }

    const rename = descriptors();
    try {
      openHandlers.set(rename.parent, () => {
        throw syscallError(2);
      });
      renameHandlers.set(rename.parent, () => {
        throw syscallError(5);
      });
      expect(() => install(rename.parent, rename.temporary, true)).toThrow(
        expect.objectContaining({ kind: "storage_unavailable" }),
      );
    } finally {
      rename.close();
    }
  });

  test("removes staging when a raced destination cannot be safely reopened", () => {
    const value = descriptors();
    let opens = 0;
    let unlinks = 0;
    try {
      openHandlers.set(value.parent, () => {
        opens += 1;
        throw syscallError(opens === 1 ? 2 : 13);
      });
      renameHandlers.set(value.parent, () => {
        throw syscallError(17);
      });
      unlinkHandlers.set(value.parent, () => {
        unlinks += 1;
      });
      expect(() => install(value.parent, value.temporary, true)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
      expect(opens).toBe(2);
      expect(unlinks).toBe(1);
    } finally {
      value.close();
    }
  });

  test("rejects a destination whose private mode changed before replacement", () => {
    const value = descriptors();
    try {
      chmodSync(`/proc/self/fd/${value.destination}`, 0o644);
      openHandlers.set(value.parent, () => value.duplicate(value.destination));
      expect(() => install(value.parent, value.temporary, true)).toThrow(
        expect.objectContaining({ kind: "unsafe_path" }),
      );
    } finally {
      value.close();
    }
  });

  test("reports unknown outcome when a rejected destination cannot remove its stage", () => {
    const value = descriptors();
    try {
      openHandlers.set(value.parent, () => value.duplicate(value.parent));
      unlinkHandlers.set(value.parent, () => {
        throw syscallError(5);
      });
      expect(() => install(value.parent, value.temporary, true)).toThrow(
        expect.objectContaining({ kind: "native_outcome_unknown" }),
      );
    } finally {
      value.close();
    }
  });

  test("reports unknown outcome when removed-stage directory durability cannot be proved", () => {
    const value = descriptors();
    let unlinks = 0;
    try {
      openHandlers.set(value.parent, () => value.duplicate(value.parent));
      unlinkHandlers.set(value.parent, () => {
        unlinks += 1;
        closeSync(value.parent);
      });
      expect(() => install(value.parent, value.temporary, true)).toThrow(
        expect.objectContaining({ kind: "native_outcome_unknown" }),
      );
      expect(unlinks).toBe(1);
    } finally {
      try {
        value.close();
      } catch {
        // The fixture deliberately invalidated the parent descriptor before fsync.
      }
    }
  });
});

describe("Linux stale export stage cleanup races", () => {
  test("tolerates descriptor-relative disappearance races but rejects cleanup I/O faults", () => {
    const value = cleanupFixture();
    const path = privateStage(value.root);
    const staleNow = lstatSync(path).ctimeMs + exportStageMinimumAgeMs + 1;
    openOverride = () => {
      throw syscallError(2);
    };
    expect(() => cleanupStaleExportStages(value.descriptor, staleNow)).not.toThrow();

    let opens = 0;
    openOverride = (args) => {
      opens += 1;
      if (opens === 2) throw syscallError(2);
      return systemOpenAt(...args);
    };
    expect(() => cleanupStaleExportStages(value.descriptor, staleNow)).not.toThrow();

    openOverride = () => {
      throw syscallError(5);
    };
    expect(() => cleanupStaleExportStages(value.descriptor, staleNow)).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    openOverride = () => -1;
    expect(() => cleanupStaleExportStages(value.descriptor, staleNow)).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    closeSync(value.descriptor);
  });

  test("classifies stale unlink races and cleanup durability failures", () => {
    const missing = cleanupFixture();
    const missingPath = privateStage(missing.root);
    const missingNow = lstatSync(missingPath).ctimeMs + exportStageMinimumAgeMs + 1;
    unlinkHandlers.set(missing.descriptor, () => {
      throw syscallError(2);
    });
    expect(() => cleanupStaleExportStages(missing.descriptor, missingNow)).not.toThrow();
    unlinkHandlers.delete(missing.descriptor);
    closeSync(missing.descriptor);

    const failed = cleanupFixture();
    const failedPath = privateStage(failed.root);
    const failedNow = lstatSync(failedPath).ctimeMs + exportStageMinimumAgeMs + 1;
    unlinkHandlers.set(failed.descriptor, () => {
      throw syscallError(5);
    });
    expect(() => cleanupStaleExportStages(failed.descriptor, failedNow)).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    unlinkHandlers.delete(failed.descriptor);
    closeSync(failed.descriptor);

    const durability = cleanupFixture();
    const durabilityPath = privateStage(durability.root);
    const durabilityNow = lstatSync(durabilityPath).ctimeMs + exportStageMinimumAgeMs + 1;
    unlinkHandlers.set(durability.descriptor, (parent, name) => {
      systemUnlinkAt(parent, name);
      closeSync(parent);
    });
    expect(() => cleanupStaleExportStages(durability.descriptor, durabilityNow)).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    unlinkHandlers.delete(durability.descriptor);
  });
});

describe("Linux stale export cleanup fault boundaries", () => {
  test("fails closed for stage identity races and descriptor scan faults", () => {
    const value = cleanupFixture();
    const stage = privateStage(value.root);
    const other = join(value.root, "other-private");
    writeFileSync(other, "other", { mode: 0o600 });
    const nowMs = lstatSync(stage).ctimeMs + exportStageMinimumAgeMs + 1;
    let stageOpens = 0;
    openOverride = (args) => {
      if (args[1] !== stageName) return systemOpenAt(...args);
      stageOpens += 1;
      return stageOpens === 1
        ? systemOpenAt(...args)
        : openSync(other, actualSyscalls.linuxFlags.oPath);
    };
    expect(() => cleanupStaleExportStages(value.descriptor, nowMs)).toThrow(
      expect.objectContaining({ kind: "unsafe_path" }),
    );

    stageOpens = 0;
    openOverride = (args) => {
      if (args[1] !== stageName) return systemOpenAt(...args);
      stageOpens += 1;
      if (stageOpens === 2) throw syscallError(5);
      return systemOpenAt(...args);
    };
    expect(() => cleanupStaleExportStages(value.descriptor, nowMs)).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    openOverride = undefined;
    closeSync(value.descriptor);

    const closed = cleanupFixture();
    closeSync(closed.descriptor);
    expect(() => cleanupStaleExportStages(closed.descriptor, Date.now())).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
  });
});
