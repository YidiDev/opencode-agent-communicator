import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureOwnedDatabase,
  verifyDatabaseCeiling,
} from "../../../../src/adapters/store/database-configuration";
import { checkDeliveryCreateQuotas } from "../../../../src/adapters/store/delivery-quotas";
import {
  classifyDeliveryStorageError,
  classifySqliteStorageError,
} from "../../../../src/adapters/store/delivery-repository";
import { type DeliveryRow, hydrateDelivery } from "../../../../src/adapters/store/delivery-rows";
import { applyMigrations } from "../../../../src/adapters/store/migrations";
import type { OwnershipRepository } from "../../../../src/adapters/store/ownership-repository";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { StoreMaintenanceRepository } from "../../../../src/adapters/store/store-maintenance-repository";
import {
  checkpointDatabase,
  integerStoreOption,
} from "../../../../src/adapters/store/store-runtime-helpers";
import {
  type StoreContext,
  StoreIntegrityError,
  StoreSecurityError,
} from "../../../../src/adapters/store/store-types";
import type { PrepareDeliveryInput } from "../../../../src/application/delivery-ports";
import { validateDeliveryId, validateNativeMessageId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import { OwnershipLostFault } from "../../../../src/domain/ownership";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("workspace:critical-faults"));
const otherWorkspace = valid(validateWorkspaceKey("workspace:other-faults"));
const source = valid(validateSessionId("ses_sourceFault"));
const target = valid(validateSessionId("ses_targetFault"));

function location(): string {
  const root = mkdtempSync(join(tmpdir(), "store-critical-faults-"));
  roots.push(root);
  return join(root, "state");
}

function ids(index: number) {
  const suffix = index.toString(16).padStart(32, "0");
  return {
    delivery: valid(validateDeliveryId(`dlv_${suffix}`)),
    message: valid(validateNativeMessageId(`msg_${suffix}`)),
  };
}

function prepared(
  token: Awaited<ReturnType<LinuxBunSqliteStore["acquire"]>>,
  index: number,
  overrides: Partial<PrepareDeliveryInput> = {},
): PrepareDeliveryInput {
  const generated = ids(index);
  return {
    fencingToken: token,
    id: generated.delivery,
    workspaceKey: workspace,
    sourceSessionId: source,
    targetSessionId: target,
    nativeMessageId: generated.message,
    envelope: '{"payload":{"content":"fault-test"}}',
    contentByteLength: 10,
    contentSha256: "a".repeat(64) as Sha256Digest,
    nowMs: 10_000,
    ...overrides,
  };
}

function openStore(): LinuxBunSqliteStore {
  return new LinuxBunSqliteStore({
    stateDirectory: location(),
    workspaceKey: workspace,
    ownerId: "critical-fault-owner",
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: () => 10_000,
    nowMonotonicMs: () => 10_000,
  });
}

describe("critical store configuration and helper faults", () => {
  test("rejects invalid adapter options and malformed checkpoint diagnostics", () => {
    expect(() => integerStoreOption("limit", 0, 1, 2)).toThrow(StoreSecurityError);
    expect(() => integerStoreOption("limit", 3, 1, 2)).toThrow(StoreSecurityError);
    const malformed = {
      query: () => ({ get: () => ({ busy: "not-a-number" }) }),
    } as unknown as Database;
    expect(() => checkpointDatabase(malformed)).toThrow(StoreSecurityError);
  });

  test("rejects a database already beyond the configured page ceiling", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES ('occupied')");
    expect(() => verifyDatabaseCeiling(database, 1)).toThrow(StoreSecurityError);
    database.close(true);

    const pragmaValues = new Map<string, Readonly<Record<string, number | string>>>([
      ["journal_mode", { value: "wal" }],
      ["page_size", { value: 512 }],
      ["page_count AS", { value: 2 }],
      ["PRAGMA max_page_count", { max_page_count: 1 }],
      ["journal_size_limit", { value: 512 }],
      ["PRAGMA wal_autocheckpoint", { wal_autocheckpoint: 256 }],
    ]);
    const oversized = {
      exec: () => undefined,
      query: (sql: string) => ({
        get: () => [...pragmaValues].find(([fragment]) => sql.includes(fragment))?.[1],
      }),
    } as unknown as Database;
    expect(() => configureOwnedDatabase(oversized, 512)).toThrow(StoreSecurityError);
  });

  test("fails closed on malformed quota and maintenance query rows", () => {
    const malformedDatabase = {
      run: () => ({ changes: 0 }),
      query: () => ({ get: () => undefined }),
    };
    const context = {
      database: malformedDatabase,
      workspaceKey: workspace,
      limits: {
        rateWindowMs: 1,
        deliveryRecordsPerWorkspace: 1,
        deliveryRecordsPerSource: 1,
        deliveryRecordsPerTarget: 1,
      },
    } as unknown as StoreContext;
    expect(() => checkDeliveryCreateQuotas(context, prepared(1 as never, 1), 1)).toThrow(
      StoreIntegrityError,
    );

    const ownership = {
      assertImplicitCurrent: () => 1,
      assertOrdinaryWorkAllowed: () => undefined,
    } as unknown as OwnershipRepository;
    const maintenance = new StoreMaintenanceRepository(context, ownership);
    expect(() =>
      maintenance.garbageCollectDeliveryMetadata({
        fencingToken: 1 as never,
        workspaceKey: workspace,
        limit: 0,
      }),
    ).toThrow(StoreIntegrityError);
    expect(() => maintenance.readStorageDiagnostics()).toThrow(StoreIntegrityError);
  });

  test("classifies structured uniqueness and unknown faults without message matching", () => {
    expect(
      classifySqliteStorageError({ code: "SQLITE_CONSTRAINT_UNIQUE", errno: 2_067 }, () => false),
    ).toBe("state_conflict");
    expect(
      classifySqliteStorageError(
        { code: "SQLITE_CONSTRAINT_PRIMARYKEY", errno: 1_555 },
        () => false,
      ),
    ).toBe("state_conflict");
    expect(classifyDeliveryStorageError(new OwnershipLostFault("lost"), () => false)).toBe(
      "ownership_lost",
    );
    expect(classifyDeliveryStorageError(new StoreIntegrityError("fault"), () => false)).toBe(
      "state_conflict",
    );
    expect(classifyDeliveryStorageError(new Error("localized"), () => false)).toBe(
      "storage_unavailable",
    );
  });
});

describe("critical delivery repository boundaries", () => {
  test("rejects cross-workspace writes, oversized envelopes, and absent transition targets", async () => {
    const store = openStore();
    const token = await store.acquire();
    expect(
      await store.createPrepared(prepared(token, 2, { workspaceKey: otherWorkspace })),
    ).toEqual({
      ok: false,
      code: "state_conflict",
    });
    expect(
      await store.createPrepared(prepared(token, 3, { envelope: "x".repeat(65_537) })),
    ).toEqual({
      ok: false,
      code: "quota_exceeded",
    });
    const absent = {
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: ids(4).delivery,
      nowMs: 10_001,
    };
    expect(await store.claimPrepared(absent)).toEqual({ ok: false, code: "state_conflict" });
    expect(await store.completeSubmission({ ...absent, state: "failed" })).toEqual({
      ok: false,
      code: "state_conflict",
    });
    for (const operation of [
      () => store.cancelPrepared({ ...absent, workspaceKey: otherWorkspace }),
      () => store.claimPrepared({ ...absent, workspaceKey: otherWorkspace }),
      () => store.completeSubmission({ ...absent, workspaceKey: otherWorkspace, state: "failed" }),
    ]) {
      expect(await operation()).toEqual({ ok: false, code: "state_conflict" });
    }
    store.close();
  });

  test("validates recovery limits, barriers, cursors, and terminal completion legality", async () => {
    const store = openStore();
    const token = await store.acquire();
    const record = prepared(token, 5);
    await store.createPrepared(record);
    await expect(
      store.listRecoverable({
        fencingToken: token,
        workspaceKey: workspace,
        state: "prepared",
        limit: 0,
      }),
    ).rejects.toThrow(StoreIntegrityError);
    await expect(
      store.listRecoverable({
        fencingToken: token,
        workspaceKey: workspace,
        state: "submitting",
        limit: 1,
      } as Parameters<LinuxBunSqliteStore["listRecoverable"]>[0]),
    ).rejects.toThrow();
    for (const cursor of [
      { createdAtMs: -1, id: record.id },
      { createdAtMs: 1.5, id: record.id },
      { createdAtMs: 1, id: "bad" as typeof record.id },
    ]) {
      await expect(
        store.listRecoverable({
          fencingToken: token,
          workspaceKey: workspace,
          state: "prepared",
          limit: 1,
          cursor,
        }),
      ).rejects.toThrow(StoreIntegrityError);
    }
    expect(
      await store.listRecoverable({
        fencingToken: token,
        workspaceKey: workspace,
        state: "prepared",
        limit: 1,
        cursor: { createdAtMs: 0, id: ids(0).delivery },
      }),
    ).toHaveLength(1);
    await store.cancelPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: record.id,
      nowMs: 10_001,
    });
    expect(
      await store.completeSubmission({
        fencingToken: token,
        workspaceKey: workspace,
        deliveryId: record.id,
        state: "failed",
        nowMs: 10_002,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });

  test("rejects a prepared row whose private envelope was corrupted", async () => {
    const store = openStore();
    const token = await store.acquire();
    const record = prepared(token, 6);
    await store.createPrepared(record);
    const corrupter = new Database(store.databasePath, { strict: true });
    corrupter.exec("PRAGMA ignore_check_constraints = ON");
    corrupter.run("UPDATE deliveries SET prepared_envelope = NULL WHERE id = ?", [record.id]);
    corrupter.close(true);
    expect(
      await store.claimPrepared({
        fencingToken: token,
        workspaceKey: workspace,
        deliveryId: record.id,
        nowMs: 10_001,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });

  test("rolls back when SQLite triggers remove a just-written delivery", async () => {
    const store = openStore();
    const token = await store.acquire();
    const fault = new Database(store.databasePath, { strict: true });
    fault.exec(`CREATE TRIGGER remove_inserted_delivery
      AFTER INSERT ON deliveries BEGIN DELETE FROM deliveries WHERE id = NEW.id; END;`);
    fault.close(true);
    expect(await store.createPrepared(prepared(token, 7))).toEqual({
      ok: false,
      code: "state_conflict",
    });

    const repair = new Database(store.databasePath, { strict: true });
    repair.exec("DROP TRIGGER remove_inserted_delivery");
    repair.close(true);
    const record = prepared(token, 8);
    await store.createPrepared(record);
    const transitionFault = new Database(store.databasePath, { strict: true });
    transitionFault.exec(`CREATE TRIGGER remove_transitioned_delivery
      AFTER UPDATE OF state ON deliveries BEGIN DELETE FROM deliveries WHERE id = NEW.id; END;`);
    transitionFault.close(true);
    expect(
      await store.cancelPrepared({
        fencingToken: token,
        workspaceKey: workspace,
        deliveryId: record.id,
        nowMs: 10_001,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });
});

describe("strict delivery row hydration", () => {
  const row: DeliveryRow = {
    id: ids(10).delivery,
    workspaceKey: workspace,
    sourceSessionId: source,
    targetSessionId: target,
    nativeMessageId: ids(10).message,
    state: "prepared",
    contentByteLength: 1,
    contentSha256: "a".repeat(64),
    createdAtMs: 1,
    updatedAtMs: 1,
    submittedAtMs: null,
    admissionUnknownAtMs: null,
    admittedAtMs: null,
    promotedAtMs: null,
    failedAtMs: null,
    cancelledAtMs: null,
    admittedSeq: null,
    promotedSeq: null,
    evidenceObservedAtMs: null,
  };

  test("rejects malformed identifiers, states, hashes, and required numbers", () => {
    for (const override of [
      { id: "bad" },
      { state: "unknown" },
      { contentSha256: 1 },
      { contentByteLength: 1.5 },
    ]) {
      expect(() => hydrateDelivery({ ...row, ...override })).toThrow(StoreIntegrityError);
    }
  });
});

describe("migration metadata fault boundaries", () => {
  test("rejects unsupported versions and missing migration history", () => {
    const unsupported = new Database(":memory:", { strict: true });
    unsupported.exec("PRAGMA user_version = 11");
    expect(() => applyMigrations(unsupported, 1, 0)).toThrow(StoreIntegrityError);
    unsupported.close(true);

    const missing = new Database(":memory:", { strict: true });
    missing.exec("PRAGMA user_version = 1");
    expect(() => applyMigrations(missing, 1, 0)).toThrow(StoreIntegrityError);
    missing.close(true);
  });

  test("rejects ownership tables that cannot prove a safe migration lease", () => {
    const missingExpiry = new Database(":memory:", { strict: true });
    missingExpiry.exec("CREATE TABLE ownership(singleton INTEGER PRIMARY KEY)");
    expect(() => applyMigrations(missingExpiry, 1, 0)).toThrow(StoreIntegrityError);
    missingExpiry.close(true);

    for (const released of [false, true]) {
      const malformed = new Database(":memory:", { strict: true });
      malformed.exec(`CREATE TABLE ownership(
        singleton INTEGER PRIMARY KEY,
        expires_wall_ms TEXT NOT NULL,
        released_wall_ms TEXT
      ); INSERT INTO ownership VALUES (1, 'bad-expiry', ${released ? "'bad-release'" : "NULL"})`);
      expect(() => applyMigrations(malformed, 1, 0)).toThrow(StoreIntegrityError);
      malformed.close(true);
    }
  });
});

test("the SQLite store rejects malformed workspace and owner configuration", () => {
  expect(
    () =>
      new LinuxBunSqliteStore({
        stateDirectory: location(),
        workspaceKey: "bad workspace" as typeof workspace,
      }),
  ).toThrow(StoreSecurityError);
  expect(
    () =>
      new LinuxBunSqliteStore({
        stateDirectory: location(),
        workspaceKey: workspace,
        ownerId: " bad",
      }),
  ).toThrow(StoreSecurityError);
});

test("ownership establishment honors wall deadlines and persisted lease expiry", async () => {
  let wall = 10_000;
  const store = new LinuxBunSqliteStore({
    stateDirectory: location(),
    workspaceKey: workspace,
    ownerId: "ownership-boundaries",
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: () => wall,
    nowMonotonicMs: () => 10_000,
  });
  const token = await store.acquire();
  await expect(
    store.establish(token, {
      abort: new AbortController().signal,
      deadlineMs: wall,
    }),
  ).rejects.toThrow(OwnershipLostFault);
  wall = 11_001;
  expect(await store.isCurrent(token)).toBeFalse();
  store.close();
});
