import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { OwnershipRepository } from "../../../../src/adapters/store/ownership-repository";
import { RequestResultRetentionRepository } from "../../../../src/adapters/store/request-result-retention-repository";
import {
  type RequestRow,
  requestMetadataColumns,
} from "../../../../src/adapters/store/request-rows";
import type { StoreContext } from "../../../../src/adapters/store/store-types";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestTestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function raw(databasePath: string): Database {
  return new Database(databasePath, { strict: true });
}

function participant(
  fixture: Awaited<ReturnType<typeof requestFixture>>,
  role: "source" | "target",
) {
  return {
    fencingToken: fixture.fencingToken,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId:
      role === "source" ? fixture.request.sourceSessionId : fixture.request.targetSessionId,
  };
}

function contextOf(store: ReturnType<typeof openRequestStore>): StoreContext {
  return (store as unknown as { readonly context: StoreContext }).context;
}

describe("request quota corruption boundaries", () => {
  test("fails closed on unsafe pending-byte and available-result aggregates", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const first = await requestFixture(token, 1_000);
    await store.createPrepared(first);
    const database = raw(store.databasePath);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.run("UPDATE requests SET retained_content_byte_length = ? WHERE id = ?", [
      Number.MAX_SAFE_INTEGER + 1,
      first.request.id,
    ]);
    database.close(true);
    const second = await requestFixture(token, 1_001, "ses_source2", "ses_target2");
    expect(await store.createPrepared(second)).toEqual({ ok: false, code: "state_conflict" });

    const resultStore = openRequestStore();
    const resultToken = await resultStore.acquire();
    const available = await requestFixture(resultToken, 1_100);
    await resultStore.createPrepared(available);
    expect(await resultStore.signalWait(participant(available, "target"))).toMatchObject({
      ok: true,
    });
    const resultDatabase = raw(resultStore.databasePath);
    resultDatabase.exec("PRAGMA ignore_check_constraints = ON");
    resultDatabase.run("UPDATE requests SET result_byte_length = ? WHERE id = ?", [
      Number.MAX_SAFE_INTEGER + 1,
      available.request.id,
    ]);
    resultDatabase.close(true);
    const candidate = await requestFixture(
      resultToken,
      1_101,
      available.request.sourceSessionId,
      "ses_secondtarget",
    );
    await resultStore.createPrepared(candidate);
    expect(await resultStore.signalWait(participant(candidate, "target"))).toEqual({
      ok: false,
      code: "state_conflict",
    });
    store.close();
    resultStore.close();
  });
});

describe("request result expiry corruption boundaries", () => {
  test("rolls back result expiry when a hostile trigger suppresses its selected parent update", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const reached = await store.signalWait(participant(fixture, "target"));
    if (!reached.ok || reached.request.resultState !== "available")
      throw new Error("fixture failed");
    clock.set(reached.request.resultExpiresAtMs);
    const database = raw(store.databasePath);
    database.run(
      "UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1",
      [clock.wall(), clock.wall() + 300_000],
    );
    database.close(true);
    const trigger = raw(store.databasePath);
    trigger.exec(`CREATE TRIGGER suppress_result_expiry BEFORE UPDATE OF result_state ON requests
      WHEN NEW.result_state = 'expired' BEGIN SELECT RAISE(IGNORE); END;`);
    trigger.close(true);
    expect(
      await store.expireAvailableResults({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 1,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });

  test("rolls back expiry if a trigger changes the selected result to another terminal state", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const reached = await store.signalWait(participant(fixture, "target"));
    if (!reached.ok || reached.request.resultState !== "available")
      throw new Error("fixture failed");
    clock.set(reached.request.resultExpiresAtMs);
    const lease = raw(store.databasePath);
    lease.run("UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1", [
      clock.wall(),
      clock.wall() + 300_000,
    ]);
    lease.exec(`CREATE TRIGGER replace_expiry_with_ack AFTER UPDATE OF result_state ON requests
      WHEN NEW.result_state = 'expired' BEGIN
        UPDATE requests SET result_state = 'acknowledged', acknowledged_at_ms = NEW.updated_at_ms
        WHERE id = NEW.id;
      END;`);
    lease.close(true);
    expect(
      await store.expireAvailableResults({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 1,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });

  test("rolls back expiry if nested triggers move the selected parent before reread", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const reached = await store.signalWait(participant(fixture, "target"));
    if (!reached.ok || reached.request.resultState !== "available")
      throw new Error("fixture failed");
    clock.set(reached.request.resultExpiresAtMs);
    const database = raw(store.databasePath);
    database.run(
      "UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1",
      [clock.wall(), clock.wall() + 300_000],
    );
    database.exec(`
      CREATE TABLE coverage_expiry_signal(request_id TEXT NOT NULL);
      CREATE TRIGGER signal_expired_parent AFTER UPDATE OF result_state ON requests
        WHEN NEW.result_state = 'expired' BEGIN
          INSERT INTO coverage_expiry_signal(request_id) VALUES (NEW.id);
          UPDATE ownership SET owner_id = owner_id WHERE singleton = 1;
        END;
      CREATE TRIGGER move_expired_parent AFTER INSERT ON coverage_expiry_signal BEGIN
        UPDATE requests SET id = 'req_ffffffffffffffffffffffffffffffff'
        WHERE id = NEW.request_id;
      END;
    `);
    database.close(true);
    expect(
      await store.expireAvailableResults({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 1,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });

  test("fails closed if the SQLite adapter loses an updated expiry row before authoritative reread", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const reached = await store.signalWait(participant(fixture, "target"));
    if (!reached.ok || reached.request.resultState !== "available")
      throw new Error("fixture failed");
    const actual = contextOf(store);
    const row = actual.database
      .query<RequestRow, [string]>(`SELECT ${requestMetadataColumns} FROM requests WHERE id = ?`)
      .get(fixture.request.id);
    if (!row) throw new Error("expiry row absent");
    const database = new Proxy(actual.database, {
      get(target, property) {
        if (property === "query") {
          return (sql: string) => {
            const statement = target.query(sql);
            if (sql.includes("FROM requests WHERE workspace_key = ? AND id = ?")) {
              return new Proxy(statement, {
                get(statementTarget, statementProperty) {
                  if (statementProperty === "get") return () => undefined;
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                },
              });
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ownership = (store as unknown as { readonly ownershipRepository: OwnershipRepository })
      .ownershipRepository;
    const repository = new RequestResultRetentionRepository(
      { ...actual, database } as StoreContext,
      ownership,
    );
    const boundary = repository as unknown as {
      expireRowsOwned(workspace: string, nowMs: number, rows: readonly RequestRow[]): unknown;
    };
    expect(() =>
      boundary.expireRowsOwned(requestTestWorkspace(), reached.request.resultExpiresAtMs, [row]),
    ).toThrow("expired result metadata was absent");
    store.close();
  });
});

describe("request retention corruption boundaries", () => {
  test("validates retention input and rolls back a selected row when deletion is suppressed", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    expect(
      await store.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 0,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });

    const fixture = await requestFixture(token, 1_000);
    await store.createPrepared(fixture);
    await store.cancelPending(participant(fixture, "source"));
    clock.set(4_000_000_000);
    const database = raw(store.databasePath);
    database.run(
      "UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1",
      [clock.wall(), clock.wall() + 300_000],
    );
    database.exec(`CREATE TRIGGER suppress_request_gc BEFORE DELETE ON requests
      BEGIN SELECT RAISE(IGNORE); END;`);
    database.close(true);
    expect(
      await store.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 1,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });
});
