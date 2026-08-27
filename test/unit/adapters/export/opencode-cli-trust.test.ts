import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fileSystem from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withChangedOpenedInode<T>(action: () => T): T {
  const original = fileSystem.fstatSync;
  const openedInode = spyOn(fileSystem, "fstatSync").mockImplementation(((
    descriptor: number,
    options?: unknown,
  ) => {
    const value = original(descriptor, options as never);
    if (options && typeof value.ino === "bigint") {
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
        ino: value.ino + 1n,
      });
    }
    return value;
  }) as typeof fileSystem.fstatSync);
  try {
    return action();
  } finally {
    openedInode.mockRestore();
  }
}

function withWritableStatPath<T>(writablePath: string, action: () => T): T {
  const original = fileSystem.statSync;
  const writableStat = spyOn(fileSystem, "statSync").mockImplementation(((
    path: fileSystem.PathLike,
    options?: unknown,
  ) => {
    const value = original(path, options as never);
    if (path === writablePath && options && typeof value.mode === "bigint") {
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
        mode: value.mode | 0o022n,
      });
    }
    return value;
  }) as typeof fileSystem.statSync);
  try {
    return action();
  } finally {
    writableStat.mockRestore();
  }
}

const {
  closeOptionalDescriptor,
  executableIdentity,
  minimalEnvironment,
  prepareExactExecutable,
  prepareTrustedWorkingDirectory,
  sameExecutable,
  trustedWorkingDirectory,
} = await import("../../../../src/adapters/export/opencode-cli-trust");

const roots: string[] = [];

function openDescriptorCount(): number {
  return readdirSync("/proc/self/fd").length;
}

function workspace(): string {
  const base = mkdtempSync(join(tmpdir(), "communicator-export-trust-"));
  roots.push(base);
  chmodSync(base, 0o700);
  const path = join(base, "workspace");
  mkdirSync(path, { mode: 0o700 });
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode export executable trust", () => {
  test("requires an absolute executable and retains only allowlisted state environment", () => {
    expect(() =>
      executableIdentity({ executablePath: "opencode", workspaceDirectory: workspace() }),
    ).toThrow("PATH-only CLI");
    expect(minimalEnvironment({ HOME: "/state", PATH: "/evil", TERM: "dumb" })).toMatchObject({
      HOME: "/state",
      TERM: "dumb",
      XDG_CONFIG_HOME: "/",
    });
    expect(minimalEnvironment(undefined).PATH).toBeUndefined();
  });

  test("retains the exact trusted working directory inode", () => {
    const prepared = prepareTrustedWorkingDirectory({
      executablePath: "/usr/bin/true",
      workspaceDirectory: workspace(),
      trustedWorkingDirectory: "/usr/bin",
    });
    try {
      expect(prepared.path).toBe("/usr/bin");
      expect(prepared.commandPath).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
    } finally {
      closeOptionalDescriptor(prepared.descriptor);
    }
  });

  test("closes newly opened trust descriptors when post-open inspection throws", () => {
    const configuration = { executablePath: "/usr/bin/true", workspaceDirectory: workspace() };
    const beforeExecutable = openDescriptorCount();
    const executableFault = spyOn(fileSystem, "fstatSync").mockImplementation(() => {
      throw new Error("fstat failed");
    });
    try {
      expect(prepareExactExecutable(configuration)).toBeUndefined();
      expect(openDescriptorCount()).toBe(beforeExecutable);
    } finally {
      executableFault.mockRestore();
    }

    const beforeDirectory = openDescriptorCount();
    const directoryFault = spyOn(fileSystem, "fstatSync").mockImplementation(() => {
      throw new Error("fstat failed");
    });
    try {
      expect(() => prepareTrustedWorkingDirectory(configuration)).toThrow("fstat failed");
      expect(openDescriptorCount()).toBe(beforeDirectory);
    } finally {
      directoryFault.mockRestore();
    }
  });

  test("rejects the existing system temporary directory as a trusted working directory", () => {
    expect(() =>
      trustedWorkingDirectory({
        executablePath: "/usr/bin/true",
        workspaceDirectory: workspace(),
        trustedWorkingDirectory: tmpdir(),
      }),
    ).toThrow(expect.objectContaining({ message: expect.stringContaining("trusted") }));
  });

  test("drops an executable descriptor when its inode changed after trust validation", () => {
    withChangedOpenedInode(() => {
      expect(
        prepareExactExecutable({
          executablePath: "/usr/bin/true",
          workspaceDirectory: workspace(),
        }),
      ).toBeUndefined();
    });
  });

  test("rejects a changed working-directory inode after opening it", () => {
    expect(() =>
      withChangedOpenedInode(() =>
        prepareTrustedWorkingDirectory({
          executablePath: "/usr/bin/true",
          workspaceDirectory: workspace(),
          trustedWorkingDirectory: "/usr/bin",
        }),
      ),
    ).toThrow("Export cwd identity changed");
  });

  test("rejects writable parents in executable and working-directory trust chains", () => {
    expect(() =>
      withWritableStatPath("/usr/bin", () =>
        executableIdentity({
          executablePath: "/usr/bin/true",
          workspaceDirectory: workspace(),
        }),
      ),
    ).toThrow("OpenCode CLI parent is writable");

    expect(() =>
      withWritableStatPath("/usr", () =>
        trustedWorkingDirectory({
          executablePath: "/usr/bin/true",
          workspaceDirectory: workspace(),
          trustedWorkingDirectory: "/usr/bin",
        }),
      ),
    ).toThrow("Export cwd ancestor is not trusted");
  });

  test("compares the complete executable identity and retains the exact trusted inode", () => {
    const configuration = {
      executablePath: "/usr/bin/true",
      workspaceDirectory: workspace(),
    };
    const identity = executableIdentity(configuration);
    expect(sameExecutable(identity, { ...identity })).toBe(true);
    expect(sameExecutable(identity, { ...identity, inode: identity.inode + 1n })).toBe(false);
    const prepared = prepareExactExecutable(configuration);
    try {
      expect(prepared?.identity).toEqual(identity);
      expect(prepared?.command).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
    } finally {
      closeOptionalDescriptor(prepared?.descriptor);
    }
  });

  test("rejects a root-owned non-ELF file even when its ownership chain is trusted", () => {
    expect(() =>
      executableIdentity({ executablePath: "/etc/passwd", workspaceDirectory: workspace() }),
    ).toThrow("directly trusted ELF");
  });

  test("rejects a working directory contained by the untrusted workspace", () => {
    expect(() =>
      trustedWorkingDirectory({
        executablePath: "/usr/bin/true",
        workspaceDirectory: "/",
        trustedWorkingDirectory: "/",
      }),
    ).toThrow("Export cwd is not trusted");
  });

  test("walks trusted ancestors and rejects plugin-controlled executable or cwd locations", () => {
    const project = workspace();
    expect(
      trustedWorkingDirectory({
        executablePath: "/usr/bin/true",
        workspaceDirectory: project,
        trustedWorkingDirectory: "/usr/bin",
      }),
    ).toBe("/usr/bin");

    expect(() =>
      executableIdentity({
        executablePath: "/usr/bin/true",
        workspaceDirectory: project,
        pluginDirectories: ["/usr"],
      }),
    ).toThrow("Untrusted CLI path");
    expect(() =>
      trustedWorkingDirectory({
        executablePath: "/usr/bin/true",
        workspaceDirectory: project,
        trustedWorkingDirectory: "/usr/bin",
        pluginDirectories: ["/usr"],
      }),
    ).toThrow("Export cwd is not trusted");
  });
});
