import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { validateNativeMessageId, validateRequestId } from "../../../../src/domain/generated-ids";
import type { FencingToken } from "../../../../src/domain/ownership";

import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestTestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

const terminalCases = [
  ["1", "ask", "answered", "available", "admitted"],
  ["2", "wait", "reached", "available", "promoted"],
  ["3", "ask", "cancelled", "none", "delivery_failed"],
  ["4", "wait", "target_stopped", "none", "delivery_unknown"],
  ["5", "ask", "source_deleted", "none", "admitted"],
] as const;

function insertTerminalCases(raw: Database, token: FencingToken): void {
  for (const [suffix, kind, resolution, resultState] of terminalCases) {
    raw.run(
      `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
         native_message_id, kind, resolution_state, delivery_state, result_state,
         payload_byte_length, retained_content_byte_length, payload_sha256,
         created_at_ms, updated_at_ms, deadline_at_ms, submitted_at_ms,
         claimed_fencing_token, resolved_at_ms, result_byte_length, result_sha256,
         result_available_at_ms, result_expires_at_ms)
       VALUES (?, 'request-test', 'ses_source', 'ses_target', ?, ?, ?, 'submitting', ?,
         1, NULL, NULL, 1000, 3000, 10000, 2000, ?, 3000, ?, ?, ?, ?)`,
      [
        `req_${suffix.repeat(32)}`,
        `msg_${suffix.repeat(32)}`,
        kind,
        resolution,
        resultState,
        token,
        resultState === "available" ? 2 : null,
        resultState === "available" ? "a".repeat(64) : null,
        resultState === "available" ? 3000 : null,
        resultState === "available" ? 86_403_000 : null,
      ],
    );
    if (resultState === "available") {
      raw.run("INSERT INTO request_results(request_id, result_json) VALUES (?, '{}')", [
        `req_${suffix.repeat(32)}`,
      ]);
    }
  }
}

async function completeTerminalCase(
  database: LinuxBunSqliteStore,
  token: FencingToken,
  entry: (typeof terminalCases)[number],
) {
  const [suffix, , , , outcome] = entry;
  const requestId = validateRequestId(`req_${suffix.repeat(32)}`);
  const native = validateNativeMessageId(`msg_${suffix.repeat(32)}`);
  if (!requestId.ok || !native.ok) throw new Error("terminal fixture identity is invalid");
  const base = {
    fencingToken: token,
    workspaceKey: requestTestWorkspace(),
    requestId: requestId.value,
  };
  if (outcome === "admitted") {
    return database.completeDelivery({
      ...base,
      outcome,
      nativeMessageId: native.value,
      admittedSeq: 1,
      evidenceObservedAtMs: 3_500,
    });
  }
  if (outcome === "promoted") {
    return database.completeDelivery({
      ...base,
      outcome,
      nativeMessageId: native.value,
      admittedSeq: 1,
      promotedSeq: 2,
      evidenceObservedAtMs: 3_500,
    });
  }
  return database.completeDelivery({ ...base, outcome });
}

describe("late request delivery outcomes", () => {
  test("preserves representative terminal winners and available result content", async () => {
    const database = openRequestStore();
    const token = await database.acquire();
    const raw = new Database(database.databasePath, { strict: true });
    raw.exec("PRAGMA foreign_keys = ON");
    raw.run(
      "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES ('request-test', 0)",
    );
    insertTerminalCases(raw, token);
    raw.close(true);
    for (const entry of terminalCases) {
      const [, , resolution, resultState] = entry;
      const result = await completeTerminalCase(database, token, entry);
      expect(result).toMatchObject({
        ok: true,
        request: { resolutionState: resolution, resultState },
      });
    }
    const inspection = new Database(database.databasePath, { readonly: true, strict: true });
    expect(
      inspection.query<{ count: number }, []>("SELECT count(*) AS count FROM request_results").get()
        ?.count,
    ).toBe(2);
    expect(
      inspection
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM requests
         WHERE result_state = 'available' AND result_sha256 = ? AND result_byte_length = 2`,
        )
        .get("a".repeat(64))?.count,
    ).toBe(2);
    inspection.close(true);
    database.close();
  });
});

describe("request delivery chronology and store time", () => {
  test("validates submitting and unknown chronology before SQL", async () => {
    const clock = requestClock(5_000);
    const database = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
      leaseDurationMs: 100_000,
    });
    const token = await database.acquire();
    const prepared = await requestFixture(token, 5_000);
    await database.createPrepared(prepared);
    clock.set(5_010);
    await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    clock.set(5_009);
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_unknown",
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    clock.set(5_010);
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_unknown",
      }),
    ).toMatchObject({ ok: true, request: { deliveryUnknownAtMs: 5_010 } });
    clock.set(5_009);
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_failed",
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    clock.set(5_010);
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_failed",
      }),
    ).toMatchObject({
      ok: true,
      request: { deliveryUnknownAtMs: 5_010, deliveryFailedAtMs: 5_010 },
    });
    database.close();
  });

  test("uses the clock observed after caller setup for claim, evidence, and expiry", async () => {
    const clock = requestClock(5_500);
    const database = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
      leaseDurationMs: 100_000,
    });
    const token = await database.acquire();
    const prepared = await requestFixture(token, 5_500);
    await database.createPrepared(prepared);
    clock.set(25_001);
    expect(
      await database.claimPrepared({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
      }),
    ).toMatchObject({ ok: true, request: { submittedAtMs: 25_001 } });
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "admitted",
        nativeMessageId: prepared.request.nativeMessageId,
        admittedSeq: 1,
        evidenceObservedAtMs: 25_002,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await database.expireDueRequests({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        limit: 1,
      }),
    ).toEqual({ ok: true, requests: [] });
    clock.set(prepared.request.deadlineAtMs);
    expect(
      await database.expireDueRequests({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        limit: 1,
      }),
    ).toMatchObject({ ok: true, requests: [{ resolutionState: "deadline_expired" }] });
    database.close();
  });
});

describe("late request winner preservation", () => {
  test("uses persistence now while retaining earlier admission evidence time", async () => {
    const clock = requestClock(9_000);
    const database = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
    });
    const token = await database.acquire();
    const prepared = await requestFixture(token, 9_000);
    await database.createPrepared(prepared);
    clock.set(9_010);
    await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    clock.set(9_020);
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "admitted",
        nativeMessageId: prepared.request.nativeMessageId,
        admittedSeq: 1,
        evidenceObservedAtMs: 9_015,
      }),
    ).toMatchObject({
      ok: true,
      request: { admittedAtMs: 9_015, updatedAtMs: 9_020 },
    });
    clock.set(9_030);
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "promoted",
        nativeMessageId: prepared.request.nativeMessageId,
        admittedSeq: 1,
        promotedSeq: 2,
        evidenceObservedAtMs: 9_025,
      }),
    ).toMatchObject({
      ok: true,
      request: { admittedAtMs: 9_015, promotedAtMs: 9_025, updatedAtMs: 9_030 },
    });
    database.close();
  });

  test("preserves deadline winner through late failure", async () => {
    const clock = requestClock();
    const database = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
      leaseDurationMs: 100_000,
    });
    const token = await database.acquire();
    const prepared = await requestFixture(token, 10_000);
    await database.createPrepared(prepared);
    await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    clock.set(prepared.request.deadlineAtMs + 1);
    await database.expireDueRequests({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      limit: 10,
    });
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_failed",
      }),
    ).toMatchObject({
      ok: true,
      request: { resolutionState: "deadline_expired", deliveryState: "delivery_failed" },
    });
    database.close();
  });

  test("moves a terminal winner through unknown, admitted, and promoted delivery", async () => {
    const clock = requestClock();
    const database = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
      leaseDurationMs: 100_000,
    });
    const token = await database.acquire();
    const prepared = await requestFixture(token, 10_500);
    await database.createPrepared(prepared);
    await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    clock.set(prepared.request.deadlineAtMs + 3);
    await database.expireDueRequests({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      limit: 10,
    });
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_unknown",
      }),
    ).toMatchObject({ ok: true, request: { resolutionState: "deadline_expired" } });
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "admitted",
        nativeMessageId: prepared.request.nativeMessageId,
        admittedSeq: 10,
        evidenceObservedAtMs: prepared.request.deadlineAtMs + 1,
      }),
    ).toMatchObject({
      ok: true,
      request: { resolutionState: "deadline_expired", deliveryState: "admitted" },
    });
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "promoted",
        nativeMessageId: prepared.request.nativeMessageId,
        admittedSeq: 10,
        promotedSeq: 11,
        evidenceObservedAtMs: prepared.request.deadlineAtMs + 2,
      }),
    ).toMatchObject({
      ok: true,
      request: { resolutionState: "deadline_expired", deliveryState: "promoted" },
    });
    database.close();
  });

  test("chooses deadline_expired for an at-deadline definitive failure", async () => {
    const clock = requestClock();
    const database = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
      leaseDurationMs: 100_000,
    });
    const token = await database.acquire();
    const prepared = await requestFixture(token, 11_000);
    await database.createPrepared(prepared);
    await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    clock.set(prepared.request.deadlineAtMs);
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_failed",
      }),
    ).toMatchObject({
      ok: true,
      request: { resolutionState: "deadline_expired", deliveryState: "delivery_failed" },
    });
    database.close();
  });
});
