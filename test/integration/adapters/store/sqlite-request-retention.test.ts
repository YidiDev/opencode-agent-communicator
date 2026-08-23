import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { requestMetadataRetentionMs } from "../../../../src/adapters/store/request-retention-repository";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestTemporaryRoot,
  requestTestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function insertTerminal(
  database: Database,
  suffix: string,
  resolution: "answered" | "cancelled" | "deadline_expired",
  resolvedAtMs: number,
  updatedAtMs: number,
): string {
  const id = `req_${suffix.repeat(32)}`;
  const answered = resolution === "answered";
  database.run(
    `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
       native_message_id, kind, resolution_state, delivery_state, result_state,
       payload_byte_length, retained_content_byte_length, payload_sha256,
       created_at_ms, updated_at_ms, deadline_at_ms, resolved_at_ms,
       result_byte_length, result_sha256, result_available_at_ms, result_expires_at_ms)
     VALUES (?, 'request-test', 'ses_source', 'ses_target', ?, 'ask', ?, 'prepared', ?,
       1, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `msg_${suffix.repeat(32)}`,
      resolution,
      answered ? "available" : "none",
      resolvedAtMs - 1_000,
      updatedAtMs,
      resolution === "deadline_expired" ? resolvedAtMs : resolvedAtMs + 1_000,
      resolvedAtMs,
      answered ? 2 : null,
      answered ? "a".repeat(64) : null,
      answered ? resolvedAtMs : null,
      answered ? resolvedAtMs + 86_400_000 : null,
    ],
  );
  if (answered) {
    database.run("INSERT INTO request_results(request_id, result_json) VALUES (?, '{}')", [id]);
  }
  return id;
}

describe("bounded request retention", () => {
  test("uses resolved boundary, protects available results, cascades children, and bounds rates", async () => {
    const root = requestTemporaryRoot("request-retention-");
    const stateDirectory = join(root, "state");
    const bootstrap = openRequestStore({ stateDirectory });
    await bootstrap.acquire();
    bootstrap.close();
    const nowMs = 4_000_000_000;
    const cutoff = nowMs - requestMetadataRetentionMs;
    const rateCutoff = nowMs - 60_000;
    const raw = new Database(join(stateDirectory, "communicator.sqlite3"), { strict: true });
    raw.exec("PRAGMA foreign_keys = ON");
    raw.run(
      "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES ('request-test', 0)",
    );
    const cancelled = insertTerminal(raw, "1", "cancelled", cutoff, nowMs - 1);
    insertTerminal(raw, "2", "deadline_expired", cutoff - 1, cutoff - 1);
    const available = insertTerminal(raw, "3", "answered", cutoff - 10, cutoff - 10);
    expect(() =>
      raw.run(
        "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, '{}', '{}')",
        [cancelled],
      ),
    ).toThrow();
    raw.run(
      `INSERT INTO request_rate_events(workspace_key, source_session_id, target_session_id, occurred_at_ms)
       VALUES ('request-test','ses_source','ses_target',?),
              ('request-test','ses_source','ses_target',?)`,
      [rateCutoff, rateCutoff + 1],
    );
    raw.close(true);

    const collector = openRequestStore({
      stateDirectory,
      workspaceKey: requestTestWorkspace(),
      nowWallMs: () => nowMs,
      nowMonotonicMs: () => 1,
    });
    const token = await collector.acquire();
    expect(
      await collector.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 1,
      }),
    ).toEqual({ ok: true, deletedRequests: 1, deletedRateEvents: 1 });
    expect(
      await collector.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 10,
      }),
    ).toEqual({ ok: true, deletedRequests: 1, deletedRateEvents: 0 });
    const inspection = new Database(collector.databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM requests WHERE id = ?")
        .get(available)?.count,
    ).toBe(1);
    expect(
      inspection
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM request_payloads WHERE request_id = ?",
        )
        .get(cancelled)?.count,
    ).toBe(0);
    expect(
      inspection
        .query<{ count: number }, []>("SELECT count(*) AS count FROM request_rate_events")
        .get()?.count,
    ).toBe(1);
    inspection.close(true);
    collector.close();
  });
});
