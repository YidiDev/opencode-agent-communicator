import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestFixture,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

describe("request claim private-state integrity", () => {
  test("fails closed before CAS when the exact pending wait edge is missing or wrong", async () => {
    for (const variant of ["missing", "wrong"] as const) {
      const store = openRequestStore();
      const token = await store.acquire();
      const prepared = await requestFixture(token, variant === "missing" ? 13_100 : 13_101);
      await store.createPrepared(prepared);
      const corruption = new Database(store.databasePath, { strict: true });
      if (variant === "missing") {
        corruption.run("DELETE FROM request_wait_edges WHERE request_id = ?", [
          prepared.request.id,
        ]);
      } else {
        corruption.exec("PRAGMA foreign_keys = OFF");
        corruption.run(
          "UPDATE request_wait_edges SET source_session_id = 'ses_intruder' WHERE request_id = ?",
          [prepared.request.id],
        );
      }
      corruption.close(true);
      expect(
        await store.claimPrepared({
          fencingToken: token,
          workspaceKey: prepared.request.workspaceKey,
          requestId: prepared.request.id,
        }),
      ).toEqual({ ok: false, code: "state_conflict" });
      const inspection = new Database(store.databasePath, { readonly: true, strict: true });
      expect(
        inspection
          .query<{ state: string }, [string]>(
            "SELECT delivery_state AS state FROM requests WHERE id = ?",
          )
          .get(prepared.request.id)?.state,
      ).toBe("prepared");
      inspection.close(true);
      store.close();
    }
  });
});
