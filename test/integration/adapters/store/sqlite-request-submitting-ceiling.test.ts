import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestFixture,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test("request claim atomically rejects the 4097th all-state submitting row", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const prepared = await requestFixture(token, 9_000);
  expect(await store.createPrepared(prepared)).toMatchObject({ ok: true });

  const seeder = new Database(store.databasePath, { strict: true });
  seeder.exec(`WITH RECURSIVE n(value) AS (
    SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 4096
  ) INSERT INTO requests(
    id, workspace_key, source_session_id, target_session_id, native_message_id, kind,
    resolution_state, delivery_state, result_state, payload_byte_length,
    created_at_ms, updated_at_ms, deadline_at_ms, submitted_at_ms,
    claimed_fencing_token, resolved_at_ms
  ) SELECT 'req_' || printf('%032x', value), 'request-test', 'ses_terminalsource',
    'ses_terminaltarget', 'msg_' || printf('%032x', value), 'wait', 'cancelled',
    'submitting', 'none', 1, 1, 2, 1001, 2, 1, 1 FROM n`);
  seeder.close(true);

  expect(
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    }),
  ).toEqual({ ok: false, code: "quota_exceeded" });
  const observer = new Database(store.databasePath, { readonly: true, strict: true });
  expect(
    observer
      .query<{ state: string; submitted: number | null }, [string]>(
        `SELECT delivery_state AS state, submitted_at_ms AS submitted
         FROM requests WHERE id = ?`,
      )
      .get(prepared.request.id),
  ).toEqual({ state: "prepared", submitted: null });
  observer.close(true);
  store.close();
});
