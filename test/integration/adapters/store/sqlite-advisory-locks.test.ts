import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations, sqliteStoreMigrations } from "../../../../src/adapters/store/migrations";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import type { AdvisoryLockPersistencePort } from "../../../../src/application/advisory-lock-ports";
import { validateAdvisoryLockId } from "../../../../src/domain/generated-ids";
import type { FencingToken } from "../../../../src/domain/ownership";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const roots: string[] = [];
const stores: LinuxBunSqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("workspace:locks"));
const foreignWorkspace = valid(validateWorkspaceKey("workspace:foreign"));
const holder = valid(validateSessionId("ses_holder"));
const otherHolder = valid(validateSessionId("ses_other"));

function lockId(index: number) {
  return valid(validateAdvisoryLockId(`lck_${index.toString(16).padStart(32, "0")}`));
}

function fixture(initial = 10_000) {
  let now = initial;
  const root = mkdtempSync(join(tmpdir(), "communicator-locks-"));
  roots.push(root);
  const store = new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace,
    nowWallMs: () => now,
    nowMonotonicMs: () => now,
  });
  stores.push(store);
  return { store, now: () => now, advance: (ms: number) => (now += ms) };
}

function publishInput(
  token: FencingToken,
  index: number,
  overrides: Partial<Parameters<AdvisoryLockPersistencePort["publish"]>[0]> = {},
): Parameters<AdvisoryLockPersistencePort["publish"]>[0] {
  return {
    fencingToken: token,
    workspaceKey: workspace,
    lockId: lockId(index),
    holderSessionId: holder,
    title: `Lock ${index}`,
    description: "No semantic deduplication.",
    instructions: "Coordinate, then release.",
    ttlSeconds: 60,
    ...overrides,
  };
}

describe("SQLite advisory lock persistence", () => {
  test("publishes overlapping locks concurrently as distinct rows", async () => {
    const { store } = fixture();
    const token = await store.acquire();
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) => store.publish(publishInput(token, index))),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const listed = await store.list({ fencingToken: token, workspaceKey: workspace, limit: 100 });
    expect(listed.locks).toHaveLength(16);
    expect(new Set(listed.locks.map((lock) => lock.lockId)).size).toBe(16);
  });

  test("enforces 1024 active locks and reclaims expired physical rows before publish quota", async () => {
    const clock = fixture();
    const token = await clock.store.acquire();
    for (let index = 0; index < 1_024; index += 1) {
      const result = await clock.store.publish(publishInput(token, index, { ttlSeconds: 1 }));
      if (!result.ok) throw new Error(`unexpected publish failure: ${result.code}`);
    }
    expect(await clock.store.publish(publishInput(token, 1_024))).toEqual({
      ok: false,
      code: "quota_exceeded",
    });
    clock.advance(1_000);
    expect(
      (await clock.store.list({ fencingToken: token, workspaceKey: workspace, limit: 100 })).locks,
    ).toHaveLength(0);
    expect((await clock.store.publish(publishInput(token, 1_025))).ok).toBe(true);
  });

  test("renews and releases only active caller-owned rows and never revives expiry", async () => {
    const clock = fixture();
    const token = await clock.store.acquire();
    const created = await clock.store.publish(publishInput(token, 1, { ttlSeconds: 2 }));
    expect(created.ok).toBe(true);
    expect(
      await clock.store.renew({
        fencingToken: token,
        workspaceKey: workspace,
        lockId: lockId(1),
        holderSessionId: otherHolder,
        ttlSeconds: 5,
      }),
    ).toEqual({ ok: false, code: "not_found_or_unauthorized" });
    clock.advance(500);
    const renewed = await clock.store.renew({
      fencingToken: token,
      workspaceKey: workspace,
      lockId: lockId(1),
      holderSessionId: holder,
      ttlSeconds: 5,
    });
    expect(renewed.ok && renewed.lock.expiresAtMs).toBe(clock.now() + 5_000);
    expect(
      (
        await clock.store.release({
          fencingToken: token,
          workspaceKey: workspace,
          lockId: lockId(1),
          holderSessionId: holder,
        })
      ).ok,
    ).toBe(true);
    expect(
      await clock.store.release({
        fencingToken: token,
        workspaceKey: workspace,
        lockId: lockId(1),
        holderSessionId: holder,
      }),
    ).toEqual({ ok: false, code: "not_found_or_unauthorized" });

    await clock.store.publish(publishInput(token, 2, { ttlSeconds: 1 }));
    clock.advance(1_000);
    expect(
      await clock.store.renew({
        fencingToken: token,
        workspaceKey: workspace,
        lockId: lockId(2),
        holderSessionId: holder,
        ttlSeconds: 10,
      }),
    ).toEqual({ ok: false, code: "not_found_or_unauthorized" });
  });

  test("uses descending bounded keysets, isolates workspace, and reports expiry schedule", async () => {
    const clock = fixture();
    const token = await clock.store.acquire();
    await clock.store.publish(publishInput(token, 1, { ttlSeconds: 20 }));
    await clock.store.publish(publishInput(token, 3, { ttlSeconds: 30 }));
    clock.advance(1);
    await clock.store.publish(publishInput(token, 2, { ttlSeconds: 10 }));
    const first = await clock.store.list({
      fencingToken: token,
      workspaceKey: workspace,
      limit: 2,
    });
    expect(first.locks.map((lock) => lock.lockId)).toEqual([lockId(2), lockId(3)]);
    expect(first.nextCursor).toBeDefined();
    if (!first.nextCursor) throw new Error("expected another page");
    const second = await clock.store.list({
      fencingToken: token,
      workspaceKey: workspace,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.locks.map((lock) => lock.lockId)).toEqual([lockId(1)]);
    const schedule = await clock.store.readNextExpiry({
      fencingToken: token,
      workspaceKey: workspace,
    });
    expect(schedule.storeObservedAtMs).toBe(clock.now());
    expect(schedule.nextExpiryAtMs).toBe(clock.now() + 10_000);
    expect(
      (await clock.store.publish(publishInput(token, 4, { workspaceKey: foreignWorkspace }))).ok,
    ).toBe(false);
  });

  test("rejects stale fencing tokens", async () => {
    const { store } = fixture();
    const token = await store.acquire();
    const stale = (Number(token) + 1) as FencingToken;
    expect((await store.publish(publishInput(stale, 1))).ok).toBe(false);
    expect(await store.publish(publishInput(stale, 1))).toEqual({
      ok: false,
      code: "ownership_lost",
    });
  });

  test("appends migration 13 to a version-12 database with strict schema and ceiling trigger", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL
    ) STRICT;`);
    for (const migration of sqliteStoreMigrations.slice(0, 12)) {
      database.exec(migration.sql);
      database.run(
        "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (?, ?, 0)",
        [migration.version, migration.checksum],
      );
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    applyMigrations(database, 1, 0);
    expect(
      database
        .query<{ version: number }, []>("SELECT user_version AS version FROM pragma_user_version")
        .get()?.version,
    ).toBe(13);
    expect(
      database
        .query<{ strict: number }, []>(
          "SELECT strict FROM pragma_table_list WHERE name = 'advisory_locks'",
        )
        .get()?.strict,
    ).toBe(1);
    expect(sqliteStoreMigrations).toHaveLength(13);
    database.close(true);
  });
});
