import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { requestMetadataRetentionMs } from "../../../../src/adapters/store/request-retention-repository";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestFixtureForPayload,
  requestTestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function target(fixture: Awaited<ReturnType<typeof requestFixture>>) {
  return {
    fencingToken: fixture.fencingToken,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.targetSessionId,
  };
}

function source(fixture: Awaited<ReturnType<typeof requestFixture>>) {
  return { ...target(fixture), callerSessionId: fixture.request.sourceSessionId };
}

function resultRow(databasePath: string, requestId: string) {
  const database = new Database(databasePath, { readonly: true, strict: true });
  const row = database
    .query<
      { resultJson: string; bytes: number; digest: string; resolution: string; delivery: string },
      [string]
    >(
      `SELECT rr.result_json AS resultJson, r.result_byte_length AS bytes,
        r.result_sha256 AS digest, r.resolution_state AS resolution, r.delivery_state AS delivery
       FROM requests AS r JOIN request_results AS rr ON rr.request_id = r.id WHERE r.id = ?`,
    )
    .get(requestId);
  database.close(true);
  if (!row) throw new Error("result row was absent");
  return row;
}

function setWallAndExtendLease(
  clock: ReturnType<typeof requestClock>,
  databasePath: string,
  value: number,
): void {
  clock.set(value);
  const database = new Database(databasePath, { strict: true });
  database.run(
    "UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1",
    [value, value + 300_000],
  );
  database.close(true);
}

describe("available result count and byte quotas", () => {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the three-dimensional quota matrix is intentionally explicit.
  test("enforces source, target, and workspace count independently at exact limit and reclaims on ack", async () => {
    for (const dimension of ["source", "target", "workspace"] as const) {
      const store = openRequestStore({
        limits: {
          availableResultsPerSource: dimension === "source" ? 2 : 10,
          availableResultsPerTarget: dimension === "target" ? 2 : 10,
          availableResultsPerWorkspace: dimension === "workspace" ? 2 : 10,
          requestsPerWorkspaceWindow: 20,
        },
      });
      const token = await store.acquire();
      const fixtures: Awaited<ReturnType<typeof requestFixture>>[] = [];
      for (let index = 0; index < 3; index += 1) {
        const fixture = await requestFixture(
          token,
          2_000 + index,
          dimension === "source" ? "ses_sharedsource" : `ses_source${index}`,
          dimension === "target" ? "ses_sharedtarget" : `ses_target${index}`,
        );
        await store.createPrepared(fixture);
        fixtures.push(fixture);
      }
      const first = fixtures[0];
      const second = fixtures[1];
      const third = fixtures[2];
      if (!first || !second || !third) throw new Error("quota fixtures missing");
      expect(await store.signalWait(target(first))).toMatchObject({ ok: true });
      expect(await store.signalWait(target(second))).toMatchObject({ ok: true });
      expect(await store.signalWait(target(third))).toEqual({ ok: false, code: "quota_exceeded" });
      const pending = new Database(store.databasePath, { readonly: true, strict: true });
      expect(
        pending
          .query<{ payloads: number; edges: number }, [string]>(
            `SELECT (SELECT count(*) FROM request_payloads WHERE request_id = ?1) AS payloads,
              (SELECT count(*) FROM request_wait_edges WHERE request_id = ?1) AS edges`,
          )
          .get(third.request.id),
      ).toEqual({ payloads: 1, edges: 1 });
      pending.close(true);
      await store.acknowledgeResult(source(first));
      expect(await store.signalWait(target(third))).toMatchObject({ ok: true });
      store.close();
    }
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the three-dimensional quota matrix is intentionally explicit.
  test("enforces UTF-8 byte quotas independently at exact aggregate and rejects the next byte-bearing result", async () => {
    const canonicalBytes = new TextEncoder().encode('{"kind":"wait"}').length;
    for (const dimension of ["source", "target", "workspace"] as const) {
      const store = openRequestStore({
        limits: {
          retainedResultBytesPerSource: dimension === "source" ? canonicalBytes : 1_000,
          retainedResultBytesPerTarget: dimension === "target" ? canonicalBytes : 1_000,
          retainedResultBytesPerWorkspace: dimension === "workspace" ? canonicalBytes : 1_000,
          requestsPerWorkspaceWindow: 20,
        },
      });
      const token = await store.acquire();
      const first = await requestFixture(
        token,
        2_100,
        dimension === "source" ? "ses_sharedsource" : "ses_source0",
        dimension === "target" ? "ses_sharedtarget" : "ses_target0",
      );
      const second = await requestFixture(
        token,
        2_101,
        dimension === "source" ? "ses_sharedsource" : "ses_source1",
        dimension === "target" ? "ses_sharedtarget" : "ses_target1",
      );
      await store.createPrepared(first);
      await store.createPrepared(second);
      expect(await store.signalWait(target(first))).toMatchObject({
        ok: true,
        request: { resultByteLength: canonicalBytes },
      });
      expect(await store.signalWait(target(second))).toEqual({ ok: false, code: "quota_exceeded" });
      store.close();
    }
  });

  test("expiry reclaims quota and a modest high-cardinality source reaches its configured ceiling", async () => {
    const clock = requestClock();
    const store = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: () => 25_000,
      limits: {
        availableResultsPerSource: 32,
        requestsPerSourceWindow: 40,
        requestsPerWorkspaceWindow: 40,
      },
    });
    const token = await store.acquire();
    const fixtures: Awaited<ReturnType<typeof requestFixture>>[] = [];
    for (let index = 0; index < 32; index += 1) {
      const fixture = await requestFixture(
        token,
        2_200 + index,
        "ses_ceiling",
        `ses_target${index}`,
      );
      await store.createPrepared(fixture);
      fixtures.push(fixture);
      expect(await store.signalWait(target(fixture))).toMatchObject({ ok: true });
    }
    const last = await requestFixture(token, 2_232, "ses_ceiling", "ses_target32");
    await store.createPrepared(last);
    const first = fixtures[0];
    if (!first) throw new Error("ceiling fixtures missing");
    expect(await store.signalWait(target(last))).toEqual({ ok: false, code: "quota_exceeded" });
    const firstResult = resultRow(store.databasePath, first.request.id);
    const raw = new Database(store.databasePath, { readonly: true, strict: true });
    const expiry = raw
      .query<{ expiry: number }, [string]>(
        "SELECT result_expires_at_ms AS expiry FROM requests WHERE id = ?",
      )
      .get(first.request.id)?.expiry;
    raw.close(true);
    if (expiry === undefined) throw new Error("expiry missing");
    setWallAndExtendLease(clock, store.databasePath, expiry);
    expect(
      await store.expireAvailableResults({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 1,
      }),
    ).toMatchObject({ ok: true, requests: [{ id: first.request.id }] });
    expect(firstResult.resultJson).toBe('{"kind":"wait"}');
    const replacement = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "replacement", timeoutSeconds: 30 },
      {
        createdAtMs: clock.wall(),
        identitySeed: 250,
        sourceName: "ses_ceiling",
        targetName: "ses_replacement",
      },
    );
    expect(await store.createPrepared(replacement)).toMatchObject({ ok: true });
    expect(await store.signalWait(target(replacement))).toMatchObject({ ok: true });
    store.close();
  });
});

describe("late delivery after retained terminal result", () => {
  test("ask result survives delivery_unknown followed by admitted and promoted evidence", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixtureForPayload(token, {
      kind: "ask",
      questions: [{ prompt: "q", options: ["a"] }],
      timeoutSeconds: 30,
    });
    await store.createPrepared(fixture);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: fixture.request.id,
    });
    const answered = await store.answerAsk({ ...target(fixture), answers: [["a"]] });
    if (!answered.ok) throw new Error("answer failed");
    const exact = resultRow(store.databasePath, fixture.request.id);
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
        outcome: "delivery_unknown",
      }),
    ).toMatchObject({
      ok: true,
      request: { resolutionState: "answered", deliveryState: "delivery_unknown" },
    });
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
        outcome: "admitted",
        nativeMessageId: fixture.request.nativeMessageId,
        admittedSeq: 10,
        evidenceObservedAtMs: 25_000,
      }),
    ).toMatchObject({
      ok: true,
      request: { resolutionState: "answered", deliveryState: "admitted" },
    });
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
        outcome: "promoted",
        nativeMessageId: fixture.request.nativeMessageId,
        admittedSeq: 10,
        promotedSeq: 11,
        evidenceObservedAtMs: 25_000,
      }),
    ).toMatchObject({
      ok: true,
      request: { resolutionState: "answered", deliveryState: "promoted" },
    });
    expect(resultRow(store.databasePath, fixture.request.id)).toEqual({
      ...exact,
      delivery: "promoted",
    });
    store.close();
  });

  test("wait result survives definitive late delivery failure byte-for-byte", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: fixture.request.id,
    });
    await store.signalWait({ ...target(fixture), evidence: "reached proof" });
    const exact = resultRow(store.databasePath, fixture.request.id);
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
        outcome: "delivery_failed",
      }),
    ).toMatchObject({
      ok: true,
      request: { resolutionState: "reached", deliveryState: "delivery_failed" },
    });
    expect(resultRow(store.databasePath, fixture.request.id)).toEqual({
      ...exact,
      delivery: "delivery_failed",
    });
    store.close();
  });
});

describe("terminal metadata GC and private-state fail-closed paths", () => {
  test("acknowledged metadata uses resolved+30d, not ack or late-delivery updatedAt", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: fixture.request.id,
    });
    const reached = await store.signalWait(target(fixture));
    if (!reached.ok) throw new Error("fixture failed");
    const resolvedAt = reached.request.resolvedAtMs;
    setWallAndExtendLease(clock, store.databasePath, resolvedAt + requestMetadataRetentionMs - 1);
    await store.acknowledgeResult(source(fixture));
    await store.completeDelivery({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: fixture.request.id,
      outcome: "delivery_unknown",
    });
    expect(
      await store.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 10,
      }),
    ).toMatchObject({ ok: true, deletedRequests: 0 });
    setWallAndExtendLease(clock, store.databasePath, resolvedAt + requestMetadataRetentionMs);
    expect(
      await store.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 10,
      }),
    ).toMatchObject({ ok: true, deletedRequests: 1 });
    store.close();
  });

  test("available result remains protected from metadata GC", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const reached = await store.signalWait(target(fixture));
    if (!reached.ok) throw new Error("fixture failed");
    setWallAndExtendLease(
      clock,
      store.databasePath,
      reached.request.resolvedAtMs + requestMetadataRetentionMs,
    );
    expect(
      await store.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 10,
      }),
    ).toMatchObject({ ok: true, deletedRequests: 0 });
    expect(resultRow(store.databasePath, fixture.request.id).resultJson).toBe('{"kind":"wait"}');
    store.close();
  });

  test("expired metadata stays through resolved+30d-1 and is removed at the exact boundary", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const reached = await store.signalWait(target(fixture));
    if (!reached.ok || reached.request.resultState !== "available")
      throw new Error("fixture failed");
    setWallAndExtendLease(clock, store.databasePath, reached.request.resultExpiresAtMs);
    await store.expireAvailableResults({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      limit: 1,
    });
    const cutoff = reached.request.resolvedAtMs + requestMetadataRetentionMs;
    setWallAndExtendLease(clock, store.databasePath, cutoff - 1);
    expect(
      await store.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 10,
      }),
    ).toMatchObject({ ok: true, deletedRequests: 0 });
    setWallAndExtendLease(clock, store.databasePath, cutoff);
    expect(
      await store.collectRequestRetention({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 10,
      }),
    ).toMatchObject({ ok: true, deletedRequests: 1 });
    store.close();
  });

  test("direct terminal private injection is rejected and bypassed corruption makes every path fail closed", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: fixture.request.id,
    });
    await store.signalWait(target(fixture));
    const raw = new Database(store.databasePath, { strict: true });
    expect(() =>
      raw.run(
        "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, '{}', '{}')",
        [fixture.request.id],
      ),
    ).toThrow();
    expect(() =>
      raw.run(
        `INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id)
         VALUES (?, ?, ?, ?)`,
        [
          fixture.request.id,
          fixture.request.workspaceKey,
          fixture.request.sourceSessionId,
          fixture.request.targetSessionId,
        ],
      ),
    ).toThrow();
    raw.exec("DROP TRIGGER request_payloads_pending_insert");
    raw.run(
      "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, '{}', '{}')",
      [fixture.request.id],
    );
    raw.close(true);
    expect(await store.signalWait(target(fixture))).toEqual({ ok: false, code: "state_conflict" });
    expect(await store.cancelPending(source(fixture))).toEqual({
      ok: false,
      code: "state_conflict",
    });
    expect(await store.acknowledgeResult(source(fixture))).toEqual({
      ok: false,
      code: "state_conflict",
    });
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
        outcome: "delivery_unknown",
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });
});
