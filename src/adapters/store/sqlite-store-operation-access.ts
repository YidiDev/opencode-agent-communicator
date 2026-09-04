import type { PreparedPrivateState } from "./linux-private-path";
import type { OwnershipRepository } from "./ownership-repository";
import { checkpointDatabase, rethrowSanitizedStorageError } from "./store-runtime-helpers";
import type { SqliteDatabaseLifecycle, StoreContext } from "./store-types";

type CapacityCheckedAccess = <Value>(operation: () => Value) => Value;
type RetainCloseFailure = (cause: unknown, pendingError: unknown) => unknown;

/** Applies the SQLite facade's capacity, sidecar, and error-sanitization boundary. */
export class SqliteStoreOperationAccess {
  constructor(
    private readonly context: StoreContext,
    private readonly privateState: PreparedPrivateState,
    private readonly maximumDatabaseBytes: number,
    private readonly access: CapacityCheckedAccess,
    private readonly retainCloseFailure: RetainCloseFailure,
  ) {}

  mutate<Value>(operation: () => Value): Value {
    return this.access(operation);
  }

  inspect<Value>(operation: () => Value): Value {
    try {
      const result = operation();
      this.privateState.verifySqliteFiles();
      return result;
    } catch (cause: unknown) {
      rethrowSanitizedStorageError(cause, "SQLite storage inspection failed.");
    }
  }

  close(ownership: OwnershipRepository, databaseLifecycle: SqliteDatabaseLifecycle): void {
    let pendingError: unknown;
    let hasCurrentLease = false;
    try {
      hasCurrentLease = ownership.hasCurrentLease();
    } catch (cause: unknown) {
      pendingError = cause;
    }
    if (hasCurrentLease) {
      try {
        this.privateState.assertMutationCapacity(this.maximumDatabaseBytes, () =>
          checkpointDatabase(this.context.database),
        );
        checkpointDatabase(this.context.database);
      } catch (cause: unknown) {
        pendingError = this.retainCloseFailure(cause, pendingError);
      }
      try {
        ownership.relinquish();
      } catch (cause: unknown) {
        pendingError = this.retainCloseFailure(cause, pendingError);
      }
    }
    try {
      databaseLifecycle.close(this.context.database);
    } catch (cause: unknown) {
      pendingError ??= cause;
    } finally {
      this.privateState.close();
    }
    if (pendingError !== undefined) {
      rethrowSanitizedStorageError(pendingError, "The SQLite store could not be closed safely.");
    }
  }
}
