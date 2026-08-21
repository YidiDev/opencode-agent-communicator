import type { Database } from "bun:sqlite";

import { StoreIntegrityError, StoreSecurityError } from "./store-types";

interface PragmaTextRow {
  readonly value: string;
}

interface PragmaNumberRow {
  readonly value: number;
}

export function assertSqliteIntegrity(condition: boolean, message: string): asserts condition {
  if (!condition) throw new StoreIntegrityError(message);
}

export function readNumericPragma(database: Database, name: string): number {
  const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
  const values = Object.values(row ?? {});
  assertSqliteIntegrity(
    values.length === 1 && typeof values[0] === "number",
    `SQLite pragma ${name} returned malformed diagnostics.`,
  );
  return values[0];
}

function verifyConnectionPragmas(database: Database, busyTimeoutMs: number): void {
  const required = [
    ["foreign_keys", 1],
    ["busy_timeout", busyTimeoutMs],
    ["synchronous", 2],
    ["temp_store", 2],
    ["secure_delete", 2],
    ["trusted_schema", 0],
    ["cache_size", -2048],
    ["mmap_size", 0],
  ] as const;
  for (const [name, expected] of required) {
    assertSqliteIntegrity(
      readNumericPragma(database, name) === expected,
      `Required SQLite pragma ${name} was not established.`,
    );
  }
}

/** Configure settings private to this SQLite connection. This is safe before ownership. */
export function configureDatabaseConnection(database: Database, busyTimeoutMs: number): void {
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA temp_store = MEMORY");
  database.exec("PRAGMA secure_delete = FAST");
  database.exec("PRAGMA cache_size = -2048");
  database.exec("PRAGMA mmap_size = 0");
  verifyConnectionPragmas(database, busyTimeoutMs);
}

/** Configure file/shared settings. The caller must already hold the persisted ownership lease. */
export function configureOwnedDatabase(database: Database, maximumBytes: number): number {
  let journal = database
    .query<PragmaTextRow, []>("SELECT journal_mode AS value FROM pragma_journal_mode")
    .get();
  if (journal?.value.toLowerCase() !== "wal") {
    database.exec("PRAGMA journal_mode = WAL");
    journal = database
      .query<PragmaTextRow, []>("SELECT journal_mode AS value FROM pragma_journal_mode")
      .get();
  }
  assertSqliteIntegrity(
    journal?.value.toLowerCase() === "wal",
    "SQLite WAL mode could not be established.",
  );
  const page = database
    .query<PragmaNumberRow, []>("SELECT page_size AS value FROM pragma_page_size")
    .get();
  assertSqliteIntegrity(
    page !== null && Number.isSafeInteger(page.value) && page.value >= 512,
    "SQLite reported an invalid page size.",
  );
  const maximumPages = Math.max(1, Math.floor(maximumBytes / page.value));
  database.exec(`PRAGMA max_page_count = ${maximumPages}`);
  assertSqliteIntegrity(
    readNumericPragma(database, "max_page_count") === maximumPages,
    "The SQLite page-count resource limit was not established.",
  );
  const pageCount = database
    .query<PragmaNumberRow, []>("SELECT page_count AS value FROM pragma_page_count")
    .get();
  if (!pageCount || pageCount.value * page.value > maximumBytes) {
    throw new StoreSecurityError("The existing SQLite database exceeds its configured ceiling.");
  }
  const expectedJournalBytes = Math.min(maximumBytes, 8 * 1024 * 1024);
  database.exec(`PRAGMA journal_size_limit = ${expectedJournalBytes}`);
  database.exec("PRAGMA wal_autocheckpoint = 256");
  const journalLimit = database
    .query<PragmaNumberRow, []>("SELECT journal_size_limit AS value FROM pragma_journal_size_limit")
    .get();
  assertSqliteIntegrity(
    journalLimit?.value === expectedJournalBytes,
    "The SQLite journal resource limit was not established.",
  );
  assertSqliteIntegrity(
    readNumericPragma(database, "wal_autocheckpoint") === 256,
    "Required SQLite pragma wal_autocheckpoint was not established.",
  );
  return maximumPages;
}

/** Read-only size validation used before the process owns shared SQLite configuration. */
export function verifyDatabaseCeiling(database: Database, maximumBytes: number): void {
  const pageSize = readNumericPragma(database, "page_size");
  const pageCount = readNumericPragma(database, "page_count");
  if (pageSize * pageCount > maximumBytes) {
    throw new StoreSecurityError("The existing SQLite database exceeds its configured ceiling.");
  }
}

export function verifyDatabase(database: Database): void {
  const quick = database
    .query<PragmaTextRow, []>("SELECT quick_check AS value FROM pragma_quick_check")
    .all();
  assertSqliteIntegrity(
    quick.length === 1 && quick[0]?.value === "ok",
    "SQLite quick integrity checking failed.",
  );
  const foreignKeyViolation = database
    .query<Record<string, unknown>, []>("SELECT * FROM pragma_foreign_key_check LIMIT 1")
    .get();
  assertSqliteIntegrity(!foreignKeyViolation, "SQLite foreign-key checking failed.");
}
