import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hydrateRequest, type RequestRow } from "../../../../src/adapters/store/request-rows";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { StoreIntegrityError } from "../../../../src/adapters/store/store-types";
import { validateFencingToken } from "../../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";
import {
  cleanupRequestStoreRoots,
  requestDigestPort as digest,
  requestFixture as fixture,
  requestClock,
  serializeVerifiedRequestEnvelope,
  openRequestStore as store,
} from "../../../support/request-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupRequestStoreRoots();
});

describe("durable request admission", () => {
  test("retains the canonical inbox through claim and erases it on definitive failure", async () => {
    const database = store();
    const token = await database.acquire();
    const prepared = await fixture(token);
    expect(await database.createPrepared(prepared)).toMatchObject({
      ok: true,
      request: { deliveryState: "prepared" },
    });

    const claimed = await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    expect(claimed).toMatchObject({
      ok: true,
      envelopeJson: prepared.envelopeJson,
      request: { deliveryState: "submitting" },
    });
    const repeatedClaim = await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    expect(repeatedClaim).toMatchObject({ ok: true, request: { deliveryState: "submitting" } });
    expect(repeatedClaim).not.toHaveProperty("envelopeJson");
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_failed",
      }),
    ).toMatchObject({
      ok: true,
      request: { deliveryState: "delivery_failed", resolutionState: "delivery_failed" },
    });
    expect(
      await database.claimPrepared({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
      }),
    ).toMatchObject({ ok: true, request: { resolutionState: "delivery_failed" } });
    expect(await database.createPrepared(prepared)).toEqual({
      ok: false,
      code: "state_conflict",
    });
    database.close();
  });

  test("rejects a two-node wait cycle distinctly", async () => {
    const database = store();
    const token = await database.acquire();
    const first = await fixture(token, 2_000);
    expect(await database.createPrepared(first)).toMatchObject({ ok: true });
    const secondBase = await fixture(token, 2_001);
    const reboundEnvelope = await serializeVerifiedRequestEnvelope(
      {
        requestId: secondBase.request.id,
        nativeMessageId: secondBase.request.nativeMessageId,
        sourceSessionId: first.request.targetSessionId,
        targetSessionId: first.request.sourceSessionId,
        workspaceKey: secondBase.request.workspaceKey,
        createdAtMs: secondBase.request.createdAtMs,
        deadlineAtMs: secondBase.request.deadlineAtMs,
        payload: JSON.parse(secondBase.payloadJson),
      },
      digest,
    );
    const second = {
      ...secondBase,
      envelopeJson: reboundEnvelope,
      request: {
        ...secondBase.request,
        sourceSessionId: first.request.targetSessionId,
        targetSessionId: first.request.sourceSessionId,
      },
    };
    expect(await database.createPrepared(second)).toEqual({ ok: false, code: "deadlock_detected" });
    database.close();
  });
});

describe("durable request delivery evidence and validation", () => {
  test("scans recovery and records unknown, admitted, and promoted evidence in order", async () => {
    const database = store();
    const token = await database.acquire();
    const prepared = await fixture(token, 3_000);
    expect(await database.createPrepared(prepared)).toMatchObject({ ok: true });
    expect(
      await database.listRecoverableRequests({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        state: "prepared",
        limit: 10,
      }),
    ).toHaveLength(1);
    await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    const startupBarrier = await database.establish(token, { abort: new AbortController().signal });
    const wrongExclusion = validateFencingToken(Number(token) + 1);
    if (!wrongExclusion.ok) throw new Error(wrongExclusion.message);
    await expect(
      database.listRecoverableRequests({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        state: "submitting",
        limit: 10,
        excludeClaimedByToken: wrongExclusion.value,
        startupBarrier,
      }),
    ).rejects.toThrow();
    expect(
      await database.listRecoverableRequests({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        state: "submitting",
        limit: 10,
        excludeClaimedByToken: token,
        startupBarrier,
      }),
    ).toHaveLength(0);
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "delivery_unknown",
      }),
    ).toMatchObject({ ok: true, request: { deliveryState: "delivery_unknown" } });
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "admitted",
        nativeMessageId: prepared.request.nativeMessageId,
        admittedSeq: 4,
        evidenceObservedAtMs: 25_000,
      }),
    ).toMatchObject({ ok: true, request: { deliveryState: "admitted" } });
    expect(
      await database.completeDelivery({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
        outcome: "promoted",
        nativeMessageId: prepared.request.nativeMessageId,
        admittedSeq: 4,
        promotedSeq: 5,
        evidenceObservedAtMs: 25_000,
      }),
    ).toMatchObject({
      ok: true,
      request: {
        deliveryState: "promoted",
        admissionEvidence: { admittedSeq: 4, promotedSeq: 5 },
      },
    });
    database.close();
  });

  test("rejects non-JSON verified envelope content before mutation", async () => {
    const database = store();
    const token = await database.acquire();
    const prepared = await fixture(token, 4_000);
    expect(await database.createPrepared({ ...prepared, envelopeJson: "not-json" })).toEqual({
      ok: false,
      code: "state_conflict",
    });
    database.close();
  });

  test("rejects prepared updated-time drift and arbitrary nested envelope JSON safely", async () => {
    const database = store();
    const token = await database.acquire();
    const prepared = await fixture(token, 4_500);
    expect(
      await database.createPrepared({
        ...prepared,
        request: { ...prepared.request, updatedAtMs: prepared.request.createdAtMs + 1 },
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    const deep = `${"[".repeat(2_000)}0${"]".repeat(2_000)}`;
    expect(await database.createPrepared({ ...prepared, envelopeJson: deep })).toEqual({
      ok: false,
      code: "state_conflict",
    });
    const reordered = JSON.parse(prepared.envelopeJson);
    expect(
      await database.createPrepared({
        ...prepared,
        envelopeJson: JSON.stringify({ trust: reordered.trust, ...reordered }),
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await database.createPrepared({
        ...prepared,
        envelopeJson: prepared.envelopeJson.replace("verified_by_communicator", "peer_supplied"),
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    database.close();
  });
});

describe("request fencing and stale recovery", () => {
  test("classifies stale admission fencing and rejects corrupt hydrated rows", async () => {
    const database = store();
    const token = await database.acquire();
    const stale = validateFencingToken(Number(token) + 1);
    if (!stale.ok) throw new Error(stale.message);
    const prepared = await fixture(stale.value, 5_000);
    expect(await database.createPrepared(prepared)).toEqual({ ok: false, code: "ownership_lost" });
    const corrupt: RequestRow = {
      id: "invalid",
      workspaceKey: "request-test",
      sourceSessionId: "ses_source",
      targetSessionId: "ses_target",
      nativeMessageId: "invalid",
      kind: "wait",
      resolutionState: "pending",
      deliveryState: "prepared",
      resultState: "none",
      payloadByteLength: 1,
      payloadSha256: "0".repeat(64),
      createdAtMs: 1,
      updatedAtMs: 1,
      deadlineAtMs: 2,
      submittedAtMs: null,
      deliveryUnknownAtMs: null,
      admittedAtMs: null,
      promotedAtMs: null,
      deliveryFailedAtMs: null,
      admittedSeq: null,
      promotedSeq: null,
      evidenceObservedAtMs: null,
      resolvedAtMs: null,
      resultByteLength: null,
      resultSha256: null,
      resultAvailableAtMs: null,
      resultExpiresAtMs: null,
      resultExpiredAtMs: null,
      acknowledgedAtMs: null,
    };
    expect(() => hydrateRequest(corrupt)).toThrow(StoreIntegrityError);
    database.close();
  });

  test("classifies stale submitting requests behind the shared startup barrier", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-recovery-"));
    roots.push(root);
    const workspace = validateWorkspaceKey("request-test");
    if (!workspace.ok) throw new Error(workspace.message);
    let now = 10_000;
    const options = {
      stateDirectory: join(root, "state"),
      workspaceKey: workspace.value,
      nowWallMs: () => now,
      nowMonotonicMs: () => now,
    };
    const crashed = new LinuxBunSqliteStore(options);
    const staleToken = await crashed.acquire();
    const prepared = await fixture(staleToken, now);
    await crashed.createPrepared(prepared);
    now += 1;
    await crashed.claimPrepared({
      fencingToken: staleToken,
      workspaceKey: workspace.value,
      requestId: prepared.request.id,
    });
    now += 16_001;
    const recovering = new LinuxBunSqliteStore(options);
    const token = await recovering.acquire();
    const startupBarrier = await recovering.establish(token, {
      abort: new AbortController().signal,
    });
    const stale = await recovering.listRecoverableRequests({
      fencingToken: token,
      workspaceKey: workspace.value,
      state: "submitting",
      limit: 10,
      excludeClaimedByToken: token,
      startupBarrier,
    });
    expect(stale).toHaveLength(1);
    expect(
      await recovering.completeDelivery({
        fencingToken: token,
        workspaceKey: workspace.value,
        requestId: prepared.request.id,
        outcome: "delivery_unknown",
      }),
    ).toMatchObject({ ok: true, request: { deliveryState: "delivery_unknown" } });
    recovering.close();
    crashed.close();
  });
});

describe("request deadline and replay boundaries", () => {
  test("accepts exact create-now and rejects future-created or already-expired admission", async () => {
    const exact = store({ nowWallMs: () => 25_000, nowMonotonicMs: () => 25_000 });
    const exactToken = await exact.acquire();
    expect(await exact.createPrepared(await fixture(exactToken, 25_000))).toMatchObject({
      ok: true,
    });
    exact.close();

    const future = store({ nowWallMs: () => 25_000, nowMonotonicMs: () => 25_000 });
    const futureToken = await future.acquire();
    expect(await future.createPrepared(await fixture(futureToken, 25_001))).toEqual({
      ok: false,
      code: "state_conflict",
    });
    future.close();

    const expired = store({ nowWallMs: () => 55_000, nowMonotonicMs: () => 55_000 });
    const expiredToken = await expired.acquire();
    expect(await expired.createPrepared(await fixture(expiredToken, 25_000))).toEqual({
      ok: false,
      code: "state_conflict",
    });
    const inspection = new Database(expired.databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, []>(
          `SELECT (SELECT count(*) FROM requests) +
                  (SELECT count(*) FROM request_rate_events) +
                  (SELECT count(*) FROM request_wait_edges) AS count`,
        )
        .get()?.count,
    ).toBe(0);
    inspection.close(true);
    expired.close();
  });

  test("uses independently controlled backward and forward store-clock observations", async () => {
    let wall = 25_000;
    const database = store({
      nowWallMs: () => wall,
      nowMonotonicMs: () => 1,
      leaseDurationMs: 100_000,
    });
    const token = await database.acquire();
    expect(
      await database.createPrepared(await fixture(token, 25_000, "ses_clockA", "ses_clockB")),
    ).toMatchObject({ ok: true });
    wall = 24_500;
    expect(
      await database.createPrepared(await fixture(token, 24_500, "ses_clockC", "ses_clockD")),
    ).toMatchObject({ ok: true });
    wall = 55_001;
    expect(
      await database.createPrepared(await fixture(token, 25_001, "ses_clockE", "ses_clockF")),
    ).toEqual({ ok: false, code: "state_conflict" });
    database.close();
  });

  test("returns an exact pending replay without charging another rate event", async () => {
    const database = store();
    const token = await database.acquire();
    const prepared = await fixture(token, 6_000);
    expect(await database.createPrepared(prepared)).toMatchObject({ ok: true });
    expect(await database.createPrepared(prepared)).toMatchObject({
      ok: true,
      request: { id: prepared.request.id },
    });
    const inspection = new Database(database.databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, []>("SELECT count(*) AS count FROM request_rate_events")
        .get()?.count,
    ).toBe(1);
    inspection.close(true);
    await database.claimPrepared({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    });
    expect(await database.createPrepared(prepared)).toMatchObject({
      ok: true,
      request: { deliveryState: "submitting" },
    });
    await database.completeDelivery({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
      outcome: "delivery_unknown",
    });
    expect(await database.createPrepared(prepared)).toMatchObject({
      ok: true,
      request: { deliveryState: "delivery_unknown" },
    });
    await database.completeDelivery({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
      outcome: "admitted",
      nativeMessageId: prepared.request.nativeMessageId,
      admittedSeq: 1,
      evidenceObservedAtMs: 25_000,
    });
    expect(await database.createPrepared(prepared)).toMatchObject({
      ok: true,
      request: { deliveryState: "admitted" },
    });
    await database.completeDelivery({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
      outcome: "promoted",
      nativeMessageId: prepared.request.nativeMessageId,
      admittedSeq: 1,
      promotedSeq: 2,
      evidenceObservedAtMs: 25_000,
    });
    expect(await database.createPrepared(prepared)).toMatchObject({
      ok: true,
      request: { deliveryState: "promoted" },
    });
    const afterReplays = new Database(database.databasePath, { readonly: true, strict: true });
    expect(
      afterReplays
        .query<{ rates: number; edges: number }, []>(
          `SELECT (SELECT count(*) FROM request_rate_events) AS rates,
                  (SELECT count(*) FROM request_wait_edges) AS edges`,
        )
        .get(),
    ).toEqual({ rates: 1, edges: 1 });
    afterReplays.close(true);
    database.close();
  });
});

describe("request claim and expiry boundaries", () => {
  test("claims at deadline minus one and expires at the exact deadline and after", async () => {
    const clock = requestClock();
    const database = store({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
    const token = await database.acquire();
    const before = await fixture(token, 7_000, "ses_a", "ses_b");
    const exact = await fixture(token, 7_001, "ses_c", "ses_d");
    const after = await fixture(token, 7_002, "ses_e", "ses_f");
    for (const input of [before, exact, after]) {
      expect(await database.createPrepared(input)).toMatchObject({ ok: true });
    }
    clock.set(before.request.deadlineAtMs - 1);
    expect(
      await database.claimPrepared({
        fencingToken: token,
        workspaceKey: before.request.workspaceKey,
        requestId: before.request.id,
      }),
    ).toMatchObject({
      ok: true,
      request: { deliveryState: "submitting" },
      envelopeJson: before.envelopeJson,
    });
    clock.set(exact.request.deadlineAtMs);
    const exactClaim = await database.claimPrepared({
      fencingToken: token,
      workspaceKey: exact.request.workspaceKey,
      requestId: exact.request.id,
    });
    expect(exactClaim).toMatchObject({
      ok: true,
      request: { resolutionState: "deadline_expired", deliveryState: "prepared" },
    });
    expect(exactClaim).not.toHaveProperty("envelopeJson");
    clock.set(after.request.deadlineAtMs + 1);
    expect(
      await database.claimPrepared({
        fencingToken: token,
        workspaceKey: after.request.workspaceKey,
        requestId: after.request.id,
      }),
    ).toMatchObject({ ok: true, request: { resolutionState: "deadline_expired" } });
    database.close();
  });

  test("expires bounded due batches and excludes due prepared recovery", async () => {
    const clock = requestClock();
    const database = store({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
    const token = await database.acquire();
    const due = await fixture(token, 8_000);
    await database.createPrepared(due);
    clock.set(due.request.deadlineAtMs);
    expect(
      await database.listRecoverableRequests({
        fencingToken: token,
        workspaceKey: due.request.workspaceKey,
        state: "prepared",
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(
      await database.expireDueRequests({
        fencingToken: token,
        workspaceKey: due.request.workspaceKey,
        limit: 1,
      }),
    ).toMatchObject({
      ok: true,
      requests: [{ id: due.request.id, resolutionState: "deadline_expired" }],
    });
    database.close();
  });

  test("rejects a canonical envelope whose deadline disagrees with payload timeout", async () => {
    const database = store();
    const token = await database.acquire();
    const prepared = await fixture(token, 8_500);
    const envelope = JSON.parse(prepared.envelopeJson);
    envelope.deadline_at_ms = prepared.request.deadlineAtMs + 1;
    expect(
      await database.createPrepared({
        ...prepared,
        request: { ...prepared.request, deadlineAtMs: prepared.request.deadlineAtMs + 1 },
        envelopeJson: JSON.stringify(envelope),
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    database.close();
  });
});

describe("request admission resource security", () => {
  test("enforces each pending count and retained-content byte dimension at the final slot", async () => {
    const fencing = validateFencingToken(1);
    if (!fencing.ok) throw new Error(fencing.message);
    const sample = await fixture(fencing.value, 20_000);
    const retained =
      new TextEncoder().encode(sample.payloadJson).length +
      new TextEncoder().encode(sample.envelopeJson).length;
    const dimensions = [
      ["pendingRequestsPerSource", 1],
      ["pendingRequestsPerTarget", 1],
      ["pendingRequestsPerWorkspace", 1],
      ["pendingRequestBytesPerSource", retained],
      ["pendingRequestBytesPerTarget", retained],
      ["pendingRequestBytesPerWorkspace", retained],
    ] as const;
    for (const [dimension, maximum] of dimensions) {
      const root = mkdtempSync(join(tmpdir(), "request-quota-"));
      roots.push(root);
      const workspace = validateWorkspaceKey("request-test");
      if (!workspace.ok) throw new Error(workspace.message);
      const database = new LinuxBunSqliteStore({
        stateDirectory: join(root, "state"),
        workspaceKey: workspace.value,
        nowWallMs: () => 25_000,
        nowMonotonicMs: () => 25_000,
        limits: { [dimension]: maximum },
      });
      const token = await database.acquire();
      expect(await database.createPrepared(await fixture(token, 20_000))).toMatchObject({
        ok: true,
      });
      expect(await database.createPrepared(await fixture(token, 20_001))).toEqual({
        ok: false,
        code: "quota_exceeded",
      });
      database.close();
    }
  });

  test("serializes two same-connection contenders for the last workspace count slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-concurrent-"));
    roots.push(root);
    const workspace = validateWorkspaceKey("request-test");
    if (!workspace.ok) throw new Error(workspace.message);
    const database = new LinuxBunSqliteStore({
      stateDirectory: join(root, "state"),
      workspaceKey: workspace.value,
      nowWallMs: () => 25_000,
      nowMonotonicMs: () => 25_000,
      limits: { pendingRequestsPerWorkspace: 1 },
    });
    const token = await database.acquire();
    const results = await Promise.all([
      database.createPrepared(await fixture(token, 21_000, "ses_one", "ses_target")),
      database.createPrepared(await fixture(token, 21_001, "ses_two", "ses_target")),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "quota_exceeded")).toHaveLength(
      1,
    );
    database.close();
  });

  test("uses actual retained UTF-8 bytes and the store clock for rate events", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-rate-"));
    roots.push(root);
    const workspace = validateWorkspaceKey("request-test");
    if (!workspace.ok) throw new Error(workspace.message);
    let now = 50_000;
    const database = new LinuxBunSqliteStore({
      stateDirectory: join(root, "state"),
      workspaceKey: workspace.value,
      nowWallMs: () => now,
      nowMonotonicMs: () => now,
      leaseDurationMs: 100_000,
      limits: { requestsPerWorkspaceWindow: 1, rateWindowMs: 1_000 },
    });
    const token = await database.acquire();
    const first = await fixture(token, 49_999, "ses_rateA", "ses_rateB");
    const second = await fixture(token, 50_000, "ses_rateC", "ses_rateD");
    expect(await database.createPrepared(first)).toMatchObject({ ok: true });
    expect(await database.createPrepared(second)).toEqual({ ok: false, code: "rate_limited" });
    const inspection = new Database(database.databasePath, { readonly: true, strict: true });
    const row = inspection
      .query<{ occurredAtMs: number; retainedBytes: number }, []>(
        `SELECT event.occurred_at_ms AS occurredAtMs,
                request.retained_content_byte_length AS retainedBytes
         FROM request_rate_events AS event JOIN requests AS request ON request.workspace_key = event.workspace_key
         LIMIT 1`,
      )
      .get();
    expect(row).toEqual({
      occurredAtMs: 50_000,
      retainedBytes:
        new TextEncoder().encode(first.payloadJson).length +
        new TextEncoder().encode(first.envelopeJson).length,
    });
    inspection.close(true);
    now += 1_001;
    expect(await database.createPrepared(second)).toMatchObject({ ok: true });
    database.close();
  });

  test("enforces source, target, and workspace request rates at one event", async () => {
    const dimensions = [
      "requestsPerSourceWindow",
      "requestsPerTargetWindow",
      "requestsPerWorkspaceWindow",
    ] as const;
    for (const dimension of dimensions) {
      const root = mkdtempSync(join(tmpdir(), "request-rate-dimension-"));
      roots.push(root);
      const workspace = validateWorkspaceKey("request-test");
      if (!workspace.ok) throw new Error(workspace.message);
      const database = new LinuxBunSqliteStore({
        stateDirectory: join(root, "state"),
        workspaceKey: workspace.value,
        nowWallMs: () => 25_000,
        nowMonotonicMs: () => 25_000,
        limits: { [dimension]: 1 },
      });
      const token = await database.acquire();
      expect(await database.createPrepared(await fixture(token, 22_000))).toMatchObject({
        ok: true,
      });
      expect(await database.createPrepared(await fixture(token, 22_001))).toEqual({
        ok: false,
        code: "rate_limited",
      });
      database.close();
    }
  });

  test("returns quota_exceeded when unique-node traversal exceeds its budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-budget-"));
    roots.push(root);
    const workspace = validateWorkspaceKey("request-test");
    if (!workspace.ok) throw new Error(workspace.message);
    const database = new LinuxBunSqliteStore({
      stateDirectory: join(root, "state"),
      workspaceKey: workspace.value,
      nowWallMs: () => 25_000,
      nowMonotonicMs: () => 25_000,
      limits: { requestTraversalNodes: 2 },
    });
    const token = await database.acquire();
    expect(
      await database.createPrepared(await fixture(token, 12_000, "ses_b", "ses_c")),
    ).toMatchObject({ ok: true });
    expect(
      await database.createPrepared(await fixture(token, 12_001, "ses_c", "ses_d")),
    ).toMatchObject({ ok: true });
    expect(
      await database.createPrepared(await fixture(token, 12_004, "ses_y", "ses_c")),
    ).toMatchObject({ ok: true });
    expect(await database.createPrepared(await fixture(token, 12_002, "ses_x", "ses_b"))).toEqual({
      ok: false,
      code: "quota_exceeded",
    });
    expect(await database.createPrepared(await fixture(token, 12_003, "ses_c", "ses_b"))).toEqual({
      ok: false,
      code: "deadlock_detected",
    });
    database.close();
  });
});

describe("request durable trust and rollback", () => {
  test("fails closed when durable prepared content changes before claim", async () => {
    const database = store();
    const token = await database.acquire();
    const prepared = await fixture(token, 13_000);
    await database.createPrepared(prepared);
    const corruption = new Database(database.databasePath, { strict: true });
    corruption.run("UPDATE request_payloads SET payload_json = ? WHERE request_id = ?", [
      JSON.stringify({ kind: "wait", milestone: "changed", timeoutSeconds: 30 }),
      prepared.request.id,
    ]);
    corruption.close(true);
    expect(
      await database.claimPrepared({
        fencingToken: token,
        workspaceKey: prepared.request.workspaceKey,
        requestId: prepared.request.id,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    database.close();
  });

  test("rolls back metadata, payload, edge, and rate event on a late insert fault", async () => {
    const database = store();
    const token = await database.acquire();
    const fault = new Database(database.databasePath, { strict: true });
    fault.exec(`CREATE TRIGGER fail_request_edge BEFORE INSERT ON request_wait_edges
      BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    fault.close(true);
    expect(await database.createPrepared(await fixture(token, 14_000))).toEqual({
      ok: false,
      code: "storage_unavailable",
    });
    const inspection = new Database(database.databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, []>(
          `SELECT (SELECT count(*) FROM requests) +
                  (SELECT count(*) FROM request_payloads) +
                  (SELECT count(*) FROM request_wait_edges) +
                  (SELECT count(*) FROM request_rate_events) AS count`,
        )
        .get()?.count,
    ).toBe(0);
    inspection.close(true);
    database.close();
  });
});
