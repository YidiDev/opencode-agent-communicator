import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { requestStoreFailureCodes } from "../../../../src/application/request-ports";

import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestFixture,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

async function buildDiamond(requestTraversalNodes: number) {
  const database = openRequestStore({ limits: { requestTraversalNodes } });
  const token = await database.acquire();
  for (const [created, source, target] of [
    [16_000, "ses_b", "ses_c"],
    [16_001, "ses_b", "ses_d"],
    [16_002, "ses_c", "ses_e"],
    [16_003, "ses_d", "ses_e"],
  ] as const) {
    expect(
      await database.createPrepared(await requestFixture(token, created, source, target)),
    ).toMatchObject({ ok: true });
  }
  return { database, token };
}

describe("bounded unique-node deadlock traversal", () => {
  test("publishes deadlock and classifies a runtime self-edge", async () => {
    expect(requestStoreFailureCodes).toContain("deadlock_detected");
    const database = openRequestStore();
    const token = await database.acquire();
    const prepared = await requestFixture(token, 2_500);
    expect(
      await database.createPrepared({
        ...prepared,
        request: { ...prepared.request, targetSessionId: prepared.request.sourceSessionId },
      }),
    ).toEqual({ ok: false, code: "deadlock_detected" });
    database.close();
  });

  test("allows a dense diamond exactly at the node budget", async () => {
    const { database, token } = await buildDiamond(4);
    expect(
      await database.createPrepared(await requestFixture(token, 16_004, "ses_x", "ses_b")),
    ).toMatchObject({ ok: true });
    database.close();
  });

  test("returns quota rather than deadlock for the same acyclic DAG at budget plus one", async () => {
    const { database, token } = await buildDiamond(3);
    expect(
      await database.createPrepared(await requestFixture(token, 16_004, "ses_x", "ses_b")),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    database.close();
  });

  test("bounds work-table rows with 1024 branching pending edges", async () => {
    const database = openRequestStore();
    await database.acquire();
    const raw = new Database(database.databasePath, { strict: true });
    raw.exec("PRAGMA foreign_keys = ON");
    raw.run(
      "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES ('request-test', 0)",
    );
    raw
      .transaction(() => {
        for (let index = 0; index < 1_024; index += 1) {
          const requestId = `req_${index.toString(16).padStart(32, "0")}`;
          const messageId = `msg_${(index + 2_048).toString(16).padStart(32, "0")}`;
          const target = `ses_leaf${index}`;
          raw.run(
            `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
             native_message_id, kind, resolution_state, delivery_state, result_state,
             payload_byte_length, retained_content_byte_length, payload_sha256,
             created_at_ms, updated_at_ms, deadline_at_ms)
           VALUES (?, 'request-test', 'ses_root', ?, ?, 'wait', 'pending', 'prepared',
             'none', 1, 2, ?, 1, 1, 30001)`,
            [requestId, target, messageId, "a".repeat(64)],
          );
          raw.run(
            `INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id)
           VALUES (?, 'request-test', 'ses_root', ?)`,
            [requestId, target],
          );
        }
      })
      .immediate();
    const sql = `WITH RECURSIVE reachable(node) AS (
      VALUES (?) UNION SELECT edge.target_session_id FROM reachable
      JOIN request_wait_edges AS edge INDEXED BY request_edges_source
        ON edge.workspace_key = ? AND edge.source_session_id = reachable.node
      LIMIT ?
    ) SELECT node FROM reachable`;
    expect(
      raw.query<{ node: string }, [string, string, number]>(sql).all("ses_root", "request-test", 3),
    ).toHaveLength(3);
    expect(
      raw
        .query<{ detail: string }, [string, string, number]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all("ses_root", "request-test", 3)
        .map((row) => row.detail)
        .join(" "),
    ).toContain("request_edges_source");
    raw.close(true);
    database.close();
  });
});
