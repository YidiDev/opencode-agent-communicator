import { Database } from "bun:sqlite";

import { OwnershipLostFault } from "../../domain/ownership";
import {
  type SqliteDatabaseLifecycle,
  StoreIntegrityError,
  StoreSecurityError,
} from "./store-types";

export const defaultDatabaseLifecycle: SqliteDatabaseLifecycle = {
  open: (path, flags) => new Database(path, flags),
  close: (database) => database.close(true),
};

export function integerStoreOption(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StoreSecurityError(`${name} is outside its supported range.`);
  }
  return value;
}

export function rethrowSanitizedStorageError(cause: unknown, message: string): never {
  if (
    cause instanceof StoreSecurityError ||
    cause instanceof StoreIntegrityError ||
    cause instanceof OwnershipLostFault
  )
    throw cause;
  throw new StoreIntegrityError(message, cause instanceof Error ? { cause } : undefined);
}

export function checkpointDatabase(database: Database): void {
  const row = database.query<Record<string, unknown>, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const values = Object.values(row ?? {});
  if (
    values.length !== 3 ||
    values.some((value) => typeof value !== "number" || !Number.isSafeInteger(value)) ||
    values[0] !== 0
  )
    throw new StoreSecurityError("SQLite WAL checkpointing is blocked.");
}
