import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeLinuxPathSyscalls } from "../../../../src/adapters/store/linux-private-path";
import {
  applyMigrations,
  migrationSqlChecksum,
  sqliteStoreMigrations,
  validateMigrationChecksums,
} from "../../../../src/adapters/store/migrations";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("continuously binds every migration declaration to canonical forward SQL", () => {
  expect(() => validateMigrationChecksums()).not.toThrow();
  for (const migration of sqliteStoreMigrations) {
    expect(migration.checksum).toBe(migrationSqlChecksum(migration.sql));
    expect(migrationSqlChecksum(`${migration.sql}\n-- divergent`)).not.toBe(migration.checksum);
  }
  const mutable = sqliteStoreMigrations[0] as { checksum: string };
  const declared = mutable.checksum;
  try {
    mutable.checksum = "sha256:invalid";
    expect(() => validateMigrationChecksums()).toThrow();
  } finally {
    mutable.checksum = declared;
  }
});

test("an over-ceiling current-owner close invokes checkpointing before release", async () => {
  const root = mkdtempSync(join(tmpdir(), "communicator-close-capacity-"));
  roots.push(root);
  const workspace = validateWorkspaceKey("workspace:close-capacity");
  if (!workspace.ok) throw new Error("invalid fixture");
  const descriptors = new Map<number, string>();
  let oversized = false;
  const store = new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace.value,
    ownerId: "close-capacity",
    limits: { databaseBytes: 8 * 1024 * 1024 },
    linuxPathSyscalls: {
      ...nodeLinuxPathSyscalls,
      open: (path, flags, mode) => {
        const descriptor = nodeLinuxPathSyscalls.open(path, flags, mode);
        descriptors.set(descriptor, path);
        return descriptor;
      },
      fstat: (descriptor) => {
        const value = nodeLinuxPathSyscalls.fstat(descriptor);
        return oversized && descriptors.get(descriptor)?.endsWith("/communicator.sqlite3")
          ? { ...value, size: 9 * 1024 * 1024 }
          : value;
      },
    },
  });
  await store.acquire();
  oversized = true;
  expect(() => store.close()).toThrow("configured byte ceiling");
});

test("an explicit release permits migration immediately without waiting for grace", async () => {
  const root = mkdtempSync(join(tmpdir(), "communicator-release-migration-"));
  roots.push(root);
  const workspace = validateWorkspaceKey("workspace:migration-release");
  if (!workspace.ok) throw new Error("invalid fixture");
  const now = 10_000;
  const owner = new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace.value,
    ownerId: "release-before-migration",
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: () => now,
    nowMonotonicMs: () => now,
  });
  await owner.acquire();
  owner.close();

  const sql = "CREATE TABLE released_migration_probe(id INTEGER PRIMARY KEY) STRICT;";
  const fixture = {
    version: sqliteStoreMigrations.length + 1,
    checksum: migrationSqlChecksum(sql),
    sql,
    downSql: "DROP TABLE released_migration_probe;",
  };
  const mutable = sqliteStoreMigrations as Array<typeof fixture>;
  mutable.push(fixture);
  const database = new Database(owner.databasePath, { strict: true });
  try {
    expect(() => applyMigrations(database, now, 100)).not.toThrow();
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE name = 'released_migration_probe'",
        )
        .get()?.name,
    ).toBe("released_migration_probe");
  } finally {
    database.close(true);
    mutable.pop();
  }
});
