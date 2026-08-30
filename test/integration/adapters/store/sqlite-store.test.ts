import { Database, SQLiteError } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDeliveryStorageError,
  classifySqliteStorageError,
} from "../../../../src/adapters/store/delivery-repository";
import { sqliteStoreMigrations } from "../../../../src/adapters/store/migrations";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import {
  type SqliteStoreLimits,
  StoreIntegrityError,
  StoreSecurityError,
  sqliteStoreHardCeilings,
} from "../../../../src/adapters/store/store-types";
import type { PrepareDeliveryInput } from "../../../../src/application/delivery-ports";
import { validateDeliveryId, validateNativeMessageId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid test fixture");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("workspace:test"));
const otherWorkspace = valid(validateWorkspaceKey("workspace:other"));
const source = valid(validateSessionId("ses_source"));
const otherSource = valid(validateSessionId("ses_otherSource"));
const target = valid(validateSessionId("ses_target"));

function temporaryState(): { readonly root: string; readonly state: string } {
  const root = mkdtempSync(join(tmpdir(), "communicator-sqlite-"));
  temporaryRoots.push(root);
  return { root, state: join(root, "state") };
}

function clock(initial = 10_000): {
  readonly wall: () => number;
  readonly monotonic: () => number;
  readonly advance: (milliseconds: number) => void;
} {
  let value = initial;
  return {
    wall: () => value,
    monotonic: () => value,
    advance: (milliseconds) => {
      value += milliseconds;
    },
  };
}

function generatedId(index: number) {
  const encoded = index.toString(16).padStart(32, "0");
  return {
    deliveryId: valid(validateDeliveryId(`dlv_${encoded}`)),
    nativeMessageId: valid(validateNativeMessageId(`msg_${encoded}`)),
  };
}

function prepared(
  token: Awaited<ReturnType<LinuxBunSqliteStore["acquire"]>>,
  index: number,
  nowMs: number,
  overrides: Partial<PrepareDeliveryInput> = {},
): PrepareDeliveryInput {
  const ids = generatedId(index);
  return {
    fencingToken: token,
    id: ids.deliveryId,
    workspaceKey: workspace,
    sourceSessionId: source,
    targetSessionId: target,
    nativeMessageId: ids.nativeMessageId,
    envelope: `{"payload":{"content":"secret-${index}"}}`,
    contentByteLength: 8,
    contentSha256: "a".repeat(64) as Sha256Digest,
    nowMs,
    ...overrides,
  };
}

function openStore(input: {
  readonly state: string;
  readonly ownerId?: string;
  readonly workspaceKey?: typeof workspace;
  readonly time?: ReturnType<typeof clock>;
  readonly limits?: Partial<SqliteStoreLimits>;
}): LinuxBunSqliteStore {
  const time = input.time ?? clock();
  return new LinuxBunSqliteStore({
    stateDirectory: input.state,
    workspaceKey: input.workspaceKey ?? workspace,
    ownerId: input.ownerId ?? "owner-test",
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: time.wall,
    nowMonotonicMs: time.monotonic,
    ...(input.limits ? { limits: input.limits } : {}),
  });
}

function inspect<Value>(databasePath: string, sql: string): Value | null {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return database.query<Value, []>(sql).get();
  } finally {
    database.close(true);
  }
}

describe("Linux private SQLite initialization", () => {
  test("creates private database files, migrates append-only history, and reopens", async () => {
    const location = temporaryState();
    const time = clock();
    const first = openStore({ state: location.state, ownerId: "owner-reopen", time });
    const token = await first.acquire();
    expect(await first.createPrepared(prepared(token, 1, time.wall()))).toMatchObject({ ok: true });
    expect(lstatSync(location.state).mode & 0o777).toBe(0o700);
    expect(lstatSync(first.databasePath).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const path = `${first.databasePath}${suffix}`;
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    first.close();

    const second = openStore({ state: location.state, ownerId: "owner-reopen", time });
    expect(second.schemaVersion).toBe(14);
    const migrationCount = inspect<{ count: number }>(
      second.databasePath,
      "SELECT count(*) AS count FROM schema_migrations",
    );
    expect(migrationCount?.count).toBe(14);
    expect(Number(await second.acquire())).toBe(Number(token) + 1);
    expect(await second.readStorageDiagnostics()).toEqual({
      journalMode: "wal",
      foreignKeys: 1,
      busyTimeoutMs: 2_000,
      synchronous: 2,
      tempStore: 2,
      secureDelete: 2,
      trustedSchema: 0,
      walAutocheckpointPages: 256,
      cacheSize: -2048,
      mmapBytes: 0,
      pageSize: 4_096,
      maxPageCount: 16_384,
      journalSizeLimit: 8_388_608,
    });
    second.close();
  });

  test("rejects broad existing modes without changing them and rejects symlinked paths", () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    chmodSync(location.state, 0o755);
    chmodSync(store.databasePath, 0o644);
    store.close();
    expect(() => openStore({ state: location.state })).toThrow(StoreSecurityError);
    expect(lstatSync(location.state).mode & 0o777).toBe(0o755);
    expect(lstatSync(store.databasePath).mode & 0o777).toBe(0o644);

    const linked = join(location.root, "linked");
    symlinkSync(location.state, linked);
    expect(() => openStore({ state: linked })).toThrow(StoreSecurityError);
  });

  test("fails closed when the canonical SQLite directory identity changes", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const moved = join(location.root, "moved-state");
    renameSync(location.state, moved);
    mkdirSync(location.state, { mode: 0o700 });
    await expect(store.createPrepared(prepared(token, 60, 10_000))).rejects.toThrow(
      StoreSecurityError,
    );
    expect(existsSync(join(location.state, "communicator.sqlite3"))).toBeFalse();
    expect(
      inspect<{ count: number }>(
        join(moved, "communicator.sqlite3"),
        "SELECT count(*) AS count FROM deliveries",
      )?.count,
    ).toBe(0);
    expect(() => store.close()).toThrow(StoreSecurityError);
  });

  test("rejects configured limits above immutable ceilings and deterministic tiny databases", () => {
    const first = temporaryState();
    expect(() =>
      openStore({
        state: first.state,
        limits: { databaseBytes: sqliteStoreHardCeilings.databaseBytes + 1 },
      }),
    ).toThrow(StoreSecurityError);
    const second = temporaryState();
    expect(() => openStore({ state: second.state, limits: { databaseBytes: 4_096 } })).toThrow();
  });

  test("rejects an oversized preplaced WAL before opening SQLite", () => {
    const location = temporaryState();
    mkdirSync(location.state, { mode: 0o700 });
    writeFileSync(join(location.state, "communicator.sqlite3"), "", { mode: 0o600 });
    const wal = join(location.state, "communicator.sqlite3-wal");
    writeFileSync(wal, "", { mode: 0o600 });
    truncateSync(wal, 9 * 1024 * 1024);
    expect(() => openStore({ state: location.state })).toThrow(StoreSecurityError);
  });

  test("fails closed when append-only migration evidence is modified", () => {
    const location = temporaryState();
    const first = openStore({ state: location.state });
    first.close();
    const database = new Database(first.databasePath, { strict: true });
    database.run("UPDATE schema_migrations SET checksum = 'modified' WHERE version = 1");
    database.close(true);
    expect(() => openStore({ state: location.state })).toThrow(StoreIntegrityError);
  });

  test("does not speculate on a previous schema while its lease is active", async () => {
    const location = temporaryState();
    const time = clock();
    const first = openStore({ state: location.state, ownerId: "legacy-owner", time });
    await first.acquire();
    const database = new Database(first.databasePath, { strict: true });
    const latest = sqliteStoreMigrations.at(-1);
    if (!latest) throw new Error("missing migration fixture");
    database
      .transaction(() => {
        database.exec(latest.downSql);
        database.run("DELETE FROM schema_migrations WHERE version = ?", [latest.version]);
        database.exec(`PRAGMA user_version = ${latest.version - 1}`);
      })
      .immediate();
    database.close(true);

    expect(() => openStore({ state: location.state, ownerId: "blocked-bootstrap", time })).toThrow(
      StoreSecurityError,
    );
    expect(
      inspect<{ version: number }>(
        first.databasePath,
        "SELECT user_version AS version FROM pragma_user_version",
      )?.version,
    ).toBe(latest.version - 1);
    expect(
      inspect<{ count: number }>(
        first.databasePath,
        "SELECT count(*) AS count FROM pragma_table_info('ownership')",
      )?.count,
    ).toBe(8);

    time.advance(1_099);
    expect(() => openStore({ state: location.state, ownerId: "grace-blocked", time })).toThrow(
      StoreSecurityError,
    );
    time.advance(2);
    const migrated = openStore({ state: location.state, ownerId: "expired-bootstrap", time });
    expect(migrated.schemaVersion).toBe(14);
    migrated.close();
    first.close();
  });
});

describe("SQLite migration reversibility and schema constraints", () => {
  test("retains an executable reverse migration and can migrate forward again", () => {
    const location = temporaryState();
    const first = openStore({ state: location.state });
    first.close();
    const database = new Database(first.databasePath, { strict: true });
    const latest = sqliteStoreMigrations.at(-1);
    if (!latest) throw new Error("missing migration fixture");
    const reverse = database.transaction(() => {
      database.exec(latest.downSql);
      database.run("DELETE FROM schema_migrations WHERE version = ?", [latest.version]);
      database.exec(`PRAGMA user_version = ${latest.version - 1}`);
    });
    reverse.immediate();
    database.close(true);
    const reopened = openStore({ state: location.state });
    expect(reopened.schemaVersion).toBe(latest.version);
    reopened.close();
  });

  test("enforces identifier, timestamp, and envelope bounds in SQL", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const record = prepared(token, 59, 10_000);
    await store.createPrepared(record);
    const writer = new Database(store.databasePath, { strict: true });
    expect(() =>
      writer.run("UPDATE deliveries SET id = 'bad' WHERE id = ?", [record.id]),
    ).toThrow();
    expect(() =>
      writer.run("UPDATE deliveries SET created_at_ms = -1 WHERE id = ?", [record.id]),
    ).toThrow();
    expect(() =>
      writer.run("UPDATE deliveries SET prepared_envelope = ? WHERE id = ?", [
        "x".repeat(65_537),
        record.id,
      ]),
    ).toThrow();
    writer.close(true);
    store.close();
  });
});

describe("structured SQLite storage-failure classification", () => {
  test("treats FULL as quota only with deterministic max-page attribution", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec(
      "PRAGMA page_size = 512; PRAGMA max_page_count = 3; CREATE TABLE value(data BLOB)",
    );
    let error: unknown;
    try {
      database.run("INSERT INTO value(data) VALUES (zeroblob(16384))");
    } catch (cause: unknown) {
      error = cause;
    }
    database.close(true);
    expect(error).toBeInstanceOf(SQLiteError);
    expect((error as SQLiteError).errno & 0xff).toBe(13);
    expect(classifyDeliveryStorageError(error, () => true)).toBe("quota_exceeded");
    expect(classifyDeliveryStorageError(error, () => false)).toBe("storage_unavailable");
  });

  test("classifies actual READONLY and structured IOERR without message matching", () => {
    const location = temporaryState();
    mkdirSync(location.state, { mode: 0o700 });
    const path = join(location.state, "classification.sqlite3");
    const writer = new Database(path, { strict: true });
    writer.exec("CREATE TABLE value(id INTEGER)");
    writer.close(true);
    const reader = new Database(path, { readonly: true, strict: true });
    let readonlyError: unknown;
    try {
      reader.run("INSERT INTO value VALUES (1)");
    } catch (cause: unknown) {
      readonlyError = cause;
    }
    reader.close(true);
    expect(readonlyError).toBeInstanceOf(SQLiteError);
    expect((readonlyError as SQLiteError).errno & 0xff).toBe(8);
    expect(classifyDeliveryStorageError(readonlyError, () => true)).toBe("storage_unavailable");

    expect(classifySqliteStorageError({ errno: 10, code: "SQLITE_IOERR" }, () => true)).toBe(
      "storage_unavailable",
    );
  });
});

describe("delivery persistence and authorization", () => {
  test("claims atomically, returns the envelope process-locally, and commits its erasure", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const input = prepared(token, 2, 10_000);
    expect(await store.createPrepared(input)).toMatchObject({ ok: true });
    const claim = await store.claimPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      nowMs: 10_001,
    });
    expect(claim).toMatchObject({
      ok: true,
      envelope: input.envelope,
      delivery: { state: "submitting" },
    });
    expect(
      inspect<{ envelope: string | null }>(
        store.databasePath,
        "SELECT prepared_envelope AS envelope FROM deliveries",
      )?.envelope,
    ).toBeNull();
    store.close();
  });

  test("rolls envelope erasure back on a failed claim and cancel clears it", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const input = prepared(token, 3, 10_000);
    await store.createPrepared(input);
    const failed = await store.claimPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      nowMs: 9_999,
    });
    expect(failed).toMatchObject({ ok: false, code: "storage_unavailable" });
    expect(
      inspect<{ envelope: string | null }>(
        store.databasePath,
        "SELECT prepared_envelope AS envelope FROM deliveries",
      )?.envelope,
    ).toBe(input.envelope);
    expect(
      await store.cancelPrepared({
        fencingToken: token,
        workspaceKey: workspace,
        deliveryId: input.id,
        nowMs: 10_001,
      }),
    ).toMatchObject({ ok: true, delivery: { state: "cancelled" } });
    expect(JSON.stringify(failed)).not.toContain("secret-3");
    store.close();
  });

  test("linearizes concurrent claim and cancellation with fenced CAS", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const input = prepared(token, 4, 10_000);
    await store.createPrepared(input);
    const transition = {
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      nowMs: 10_001,
    };
    const [claim, cancel] = await Promise.all([
      store.claimPrepared(transition),
      store.cancelPrepared(transition),
    ]);
    expect(claim).toMatchObject({ ok: true, delivery: { state: "submitting" } });
    expect(cancel).toEqual({ ok: false, code: "state_conflict" });
    expect(claim).toHaveProperty("envelope", input.envelope);

    const cancelledFirst = prepared(token, 40, 10_010);
    await store.createPrepared(cancelledFirst);
    const cancelledTransition = {
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: cancelledFirst.id,
      nowMs: 10_011,
    };
    const [cancelWinner, claimLoser] = await Promise.all([
      store.cancelPrepared(cancelledTransition),
      store.claimPrepared(cancelledTransition),
    ]);
    expect(cancelWinner).toMatchObject({ ok: true, delivery: { state: "cancelled" } });
    expect(claimLoser).toMatchObject({ ok: true, delivery: { state: "cancelled" } });
    expect(claimLoser).not.toHaveProperty("envelope");
    store.close();
  });

  test("authorizes reads by exact workspace and participant without returning payload", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const input = prepared(token, 5, 10_000);
    await store.createPrepared(input);
    expect(
      await store.getForParticipant({
        workspaceKey: workspace,
        deliveryId: input.id,
        participantSessionId: source,
      }),
    ).toMatchObject({ role: "source" });
    expect(
      await store.getForParticipant({
        workspaceKey: workspace,
        deliveryId: input.id,
        participantSessionId: target,
      }),
    ).toMatchObject({ role: "target" });
    expect(
      await store.getForParticipant({
        workspaceKey: otherWorkspace,
        deliveryId: input.id,
        participantSessionId: source,
      }),
    ).toBeUndefined();
    expect(
      await store.getForParticipant({
        workspaceKey: workspace,
        deliveryId: input.id,
        participantSessionId: otherSource,
      }),
    ).toBeUndefined();
    const value = await store.getForParticipant({
      workspaceKey: workspace,
      deliveryId: input.id,
      participantSessionId: source,
    });
    expect(JSON.stringify(value)).not.toContain("secret-5");
    store.close();
  });
});

describe("workspace scope and admission evidence", () => {
  test("scopes every operation and recovery scan to one configured workspace", async () => {
    const location = temporaryState();
    const time = clock();
    const first = openStore({ state: location.state, ownerId: "scope-a", time });
    const tokenA = await first.acquire();
    const recordA = prepared(tokenA, 55, time.wall());
    await first.createPrepared(recordA);
    expect(
      await first.createPrepared(
        prepared(tokenA, 56, time.wall(), { workspaceKey: otherWorkspace }),
      ),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await first.cancelPrepared({
        fencingToken: tokenA,
        workspaceKey: otherWorkspace,
        deliveryId: recordA.id,
        nowMs: time.wall(),
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    await expect(
      first.listRecoverable({
        fencingToken: tokenA,
        workspaceKey: otherWorkspace,
        state: "prepared",
        limit: 10,
      }),
    ).rejects.toThrow(StoreIntegrityError);
    await first.claimPrepared({
      fencingToken: tokenA,
      workspaceKey: workspace,
      deliveryId: recordA.id,
      nowMs: time.wall() + 1,
    });
    first.close();

    const second = openStore({
      state: location.state,
      ownerId: "scope-b",
      workspaceKey: otherWorkspace,
      time,
    });
    const tokenB = await second.acquire();
    const recordB = prepared(tokenB, 57, time.wall(), { workspaceKey: otherWorkspace });
    await second.createPrepared(recordB);
    const listed = await second.listRecoverable({
      fencingToken: tokenB,
      workspaceKey: otherWorkspace,
      state: "prepared",
      limit: 10,
    });
    expect(listed.map((delivery) => delivery.id)).toEqual([recordB.id]);
    expect(
      await second.getForParticipant({
        workspaceKey: workspace,
        deliveryId: recordA.id,
        participantSessionId: source,
      }),
    ).toBeUndefined();
    second.close();
  });

  test("records promoted admission timestamps and evidence in one coherent mutation", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const input = prepared(token, 6, 10_000);
    await store.createPrepared(input);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      nowMs: 10_001,
    });
    const result = await store.completeSubmission({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      state: "promoted",
      admittedSeq: 40,
      promotedSeq: 41,
      evidenceObservedAtMs: 10_003,
      nowMs: 10_002,
    });
    expect(result).toMatchObject({
      ok: true,
      delivery: {
        state: "promoted",
        admittedAtMs: 10_003,
        promotedAtMs: 10_003,
        admissionEvidence: { admittedSeq: 40, promotedSeq: 41, observedAtMs: 10_003 },
      },
    });
    store.close();
  });

  test("records public message admission without fabricated sequence evidence", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const input = prepared(token, 59, 10_000);
    await store.createPrepared(input);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      nowMs: 10_001,
    });
    const result = await store.completeSubmission({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      state: "admitted",
      evidenceKind: "public_message",
      evidenceObservedAtMs: 10_002,
      nowMs: 10_002,
    });
    expect(result).toMatchObject({
      ok: true,
      delivery: {
        state: "admitted",
        admissionEvidence: {
          kind: "public_message",
          nativeMessageId: input.nativeMessageId,
          observedAtMs: 10_002,
        },
      },
    });
    expect(
      inspect<{ admittedSeq: number | null; evidenceKind: string }>(
        store.databasePath,
        `SELECT admitted_seq AS admittedSeq, admission_evidence_kind AS evidenceKind
         FROM deliveries WHERE id = '${input.id}'`,
      ),
    ).toEqual({ admittedSeq: null, evidenceKind: "public_message" });
    store.close();
  });

  test("preserves admitted history during promotion and rejects sequence mismatch", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    const input = prepared(token, 58, 10_000);
    await store.createPrepared(input);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      nowMs: 10_001,
    });
    await store.completeSubmission({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      state: "admitted",
      admittedSeq: 70,
      evidenceObservedAtMs: 10_002,
      nowMs: 10_002,
    });
    expect(
      await store.completeSubmission({
        fencingToken: token,
        workspaceKey: workspace,
        deliveryId: input.id,
        state: "promoted",
        admittedSeq: 71,
        promotedSeq: 72,
        evidenceObservedAtMs: 10_003,
        nowMs: 10_003,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    const promoted = await store.completeSubmission({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: input.id,
      state: "promoted",
      admittedSeq: 70,
      promotedSeq: 72,
      evidenceObservedAtMs: 10_004,
      nowMs: 10_004,
    });
    expect(promoted).toMatchObject({
      ok: true,
      delivery: {
        admittedAtMs: 10_002,
        promotedAtMs: 10_004,
        admissionEvidence: { admittedSeq: 70, promotedSeq: 72 },
      },
    });
    store.close();
  });
});

describe("delivery row hydration", () => {
  test("strictly hydrates admitted, unknown, and failed delivery states", async () => {
    const location = temporaryState();
    const store = openStore({ state: location.state });
    const token = await store.acquire();
    for (const [index, state] of [
      [7, "admitted"],
      [8, "admission_unknown"],
      [9, "failed"],
    ] as const) {
      const record = prepared(token, index, 10_000 + index);
      await store.createPrepared(record);
      await store.claimPrepared({
        fencingToken: token,
        workspaceKey: workspace,
        deliveryId: record.id,
        nowMs: 10_100 + index,
      });
      const completion =
        state === "admitted"
          ? await store.completeSubmission({
              fencingToken: token,
              workspaceKey: workspace,
              deliveryId: record.id,
              state,
              admittedSeq: index,
              evidenceObservedAtMs: 10_200 + index,
              nowMs: 10_200 + index,
            })
          : await store.completeSubmission({
              fencingToken: token,
              workspaceKey: workspace,
              deliveryId: record.id,
              state,
              nowMs: 10_200 + index,
            });
      expect(completion).toMatchObject({ ok: true, delivery: { state } });
      expect(
        await store.getForParticipant({
          workspaceKey: workspace,
          deliveryId: record.id,
          participantSessionId: source,
        }),
      ).toMatchObject({ delivery: { state } });
    }
    store.close();
  });
});
