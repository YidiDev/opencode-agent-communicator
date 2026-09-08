import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { sqliteStoreDefaultTakeoverGraceMs } from "../../../src/adapters/store/store-types";
import { liveDeadlineMs } from "./constants";

interface OwnershipLease {
  readonly expiresWallMs: number;
  readonly releasedWallMs: number | null;
}

function containsRequest(databasePath: string, requestID: string): boolean {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM requests WHERE id = ?")
        .get(requestID)?.count === 1
    );
  } finally {
    database.close(false);
  }
}

export async function waitForCommunicatorOwnershipTakeover(
  stateDirectory: string,
  requestID: string,
): Promise<void> {
  const stateNames = await readdir(stateDirectory);
  const databaseNames = stateNames.filter((name) => name.endsWith(".sqlite3"));
  const matchingNames = databaseNames.filter((name) =>
    containsRequest(join(stateDirectory, name), requestID),
  );
  if (matchingNames.length !== 1) throw new Error("expected one request-owning state database");
  const databasePath = join(stateDirectory, matchingNames[0] as string);
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const deadline = performance.now() + liveDeadlineMs;
    while (performance.now() < deadline) {
      const ownership = database
        .query<OwnershipLease, []>(
          `SELECT expires_wall_ms AS expiresWallMs, released_wall_ms AS releasedWallMs
           FROM ownership WHERE singleton = 1`,
        )
        .get();
      if (
        ownership !== null &&
        (ownership.releasedWallMs !== null ||
          Date.now() >= ownership.expiresWallMs + sqliteStoreDefaultTakeoverGraceMs)
      ) {
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("communicator ownership did not become eligible for takeover");
  } finally {
    database.close(false);
  }
}
