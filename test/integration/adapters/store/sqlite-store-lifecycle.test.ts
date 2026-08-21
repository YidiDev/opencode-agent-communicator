import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeLinuxPathSyscalls } from "../../../../src/adapters/store/linux-private-path";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import {
  type LinuxBunSqliteStoreOptions,
  StoreIntegrityError,
} from "../../../../src/adapters/store/store-types";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const temporaryRoots: string[] = [];
const workspaceResult = validateWorkspaceKey("workspace:lifecycle");
if (!workspaceResult.ok) throw new Error("invalid lifecycle test workspace");
const workspace = workspaceResult.value;

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryState(): string {
  const root = mkdtempSync(join(tmpdir(), "communicator-sqlite-lifecycle-"));
  temporaryRoots.push(root);
  return join(root, "state");
}

function trackedOptions(stateDirectory: string, openDescriptors: Set<number>) {
  return {
    stateDirectory,
    workspaceKey: workspace,
    linuxPathSyscalls: {
      ...nodeLinuxPathSyscalls,
      open: (path, flags, mode) => {
        const descriptor = nodeLinuxPathSyscalls.open(path, flags, mode);
        openDescriptors.add(descriptor);
        return descriptor;
      },
      close: (descriptor) => {
        nodeLinuxPathSyscalls.close(descriptor);
        openDescriptors.delete(descriptor);
      },
    },
  } satisfies LinuxBunSqliteStoreOptions;
}

describe("deterministic SQLite lifecycle cleanup", () => {
  test("closes every handle when ownership inspection fails", async () => {
    const openDescriptors = new Set<number>();
    const store = new LinuxBunSqliteStore(trackedOptions(temporaryState(), openDescriptors));
    await store.acquire();
    const corrupter = new Database(store.databasePath, { strict: true });
    corrupter.exec("PRAGMA ignore_check_constraints = ON");
    corrupter.run("UPDATE ownership SET fencing_token = 0 WHERE singleton = 1");
    corrupter.close(true);

    expect(() => store.close()).toThrow(StoreIntegrityError);
    expect(openDescriptors.size).toBe(0);
    expect(() => store.close()).not.toThrow();
  });

  test("closes the anchored descriptor and becomes terminal when SQLite close throws", () => {
    const openDescriptors = new Set<number>();
    const store = new LinuxBunSqliteStore({
      ...trackedOptions(temporaryState(), openDescriptors),
      sqliteDatabaseLifecycle: {
        open: (path, flags) => new Database(path, flags),
        close: (database) => {
          database.close(true);
          throw new Error("injected raw close detail");
        },
      },
    });
    expect(() => store.close()).toThrow(StoreIntegrityError);
    expect(openDescriptors.size).toBe(0);
    expect(() => store.close()).not.toThrow();
    expect(store.acquire()).rejects.toThrow("closed");
  });

  test("constructor cleanup closes its descriptor and preserves the primary failure", () => {
    const state = temporaryState();
    const initialized = new LinuxBunSqliteStore({ stateDirectory: state, workspaceKey: workspace });
    initialized.close();
    const corrupter = new Database(initialized.databasePath, { strict: true });
    corrupter.run("UPDATE schema_migrations SET checksum = 'invalid' WHERE version = 1");
    corrupter.close(true);
    const openDescriptors = new Set<number>();
    expect(
      () =>
        new LinuxBunSqliteStore({
          ...trackedOptions(state, openDescriptors),
          sqliteDatabaseLifecycle: {
            open: (path, flags) => new Database(path, flags),
            close: (database) => {
              database.close(true);
              throw new Error("secondary raw close failure");
            },
          },
        }),
    ).toThrow("Published SQLite migration history does not match.");
    expect(openDescriptors.size).toBe(0);
  });
});
