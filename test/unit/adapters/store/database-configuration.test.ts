import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  assertSqliteIntegrity,
  readNumericPragma,
  verifyDatabase,
} from "../../../../src/adapters/store/database-configuration";
import { StoreIntegrityError } from "../../../../src/adapters/store/store-types";

describe("SQLite configuration verification", () => {
  test("rejects malformed numeric pragma diagnostics", () => {
    const database = new Database(":memory:");
    expect(() => readNumericPragma(database, "journal_mode")).toThrow(StoreIntegrityError);
    database.close(true);
  });

  test("uses one safe integrity guard for required resource settings", () => {
    expect(() => assertSqliteIntegrity(false, "safe diagnostic")).toThrow(StoreIntegrityError);
    expect(() => assertSqliteIntegrity(true, "unused")).not.toThrow();
  });

  test("rejects foreign-key corruption during startup checking", () => {
    const database = new Database(":memory:");
    database.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
    database.exec("CREATE TABLE child(parent_id INTEGER REFERENCES parent(id))");
    database.exec("INSERT INTO child(parent_id) VALUES (1)");
    database.exec("PRAGMA foreign_keys = ON");
    expect(() => verifyDatabase(database)).toThrow(StoreIntegrityError);
    database.close(true);
  });
});
