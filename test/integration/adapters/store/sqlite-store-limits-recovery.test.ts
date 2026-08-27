import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { StoreIntegrityError } from "../../../../src/adapters/store/store-types";
import type { PrepareDeliveryInput } from "../../../../src/application/delivery-ports";
import { validateDeliveryId, validateNativeMessageId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import { OwnershipLostFault } from "../../../../src/domain/ownership";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";
import { requestFixture } from "../../../support/request-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("workspace:limits"));
const sourceA = valid(validateSessionId("ses_sourceA"));
const sourceB = valid(validateSessionId("ses_sourceB"));
const targetA = valid(validateSessionId("ses_targetA"));
const targetB = valid(validateSessionId("ses_targetB"));

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "communicator-recovery-"));
  roots.push(root);
  return join(root, "state");
}

function controlledClock(initial = 100_000) {
  let wall = initial;
  let monotonic = initial;
  return {
    wall: () => wall,
    monotonic: () => monotonic,
    now: () => wall,
    advance: (milliseconds: number) => {
      wall += milliseconds;
      monotonic += milliseconds;
    },
    moveWall: (milliseconds: number) => {
      wall += milliseconds;
    },
    moveMonotonic: (milliseconds: number) => {
      monotonic += milliseconds;
    },
  };
}

function ids(index: number) {
  const value = index.toString(16).padStart(32, "0");
  return {
    delivery: valid(validateDeliveryId(`dlv_${value}`)),
    message: valid(validateNativeMessageId(`msg_${value}`)),
  };
}

function input(
  token: Awaited<ReturnType<LinuxBunSqliteStore["acquire"]>>,
  index: number,
  nowMs: number,
  sourceSessionId = sourceA,
  targetSessionId = targetA,
): PrepareDeliveryInput {
  const generated = ids(index);
  return {
    fencingToken: token,
    id: generated.delivery,
    workspaceKey: workspace,
    sourceSessionId,
    targetSessionId,
    nativeMessageId: generated.message,
    envelope: `{"payload":{"content":"private-${index}"}}`,
    contentByteLength: 9,
    contentSha256: "b".repeat(64) as Sha256Digest,
    nowMs,
  };
}

function store(
  path: string,
  ownerId: string,
  time: ReturnType<typeof controlledClock>,
  limits: ConstructorParameters<typeof LinuxBunSqliteStore>[0]["limits"] = {},
): LinuxBunSqliteStore {
  return new LinuxBunSqliteStore({
    stateDirectory: path,
    workspaceKey: workspace,
    ownerId,
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: time.wall,
    nowMonotonicMs: time.monotonic,
    limits,
  });
}

describe("atomic delivery quotas and rates", () => {
  test.each([
    ["source", sourceA, targetB, { deliveryRecordsPerSource: 1 }],
    ["target", sourceB, targetA, { deliveryRecordsPerTarget: 1 }],
    ["workspace", sourceB, targetB, { deliveryRecordsPerWorkspace: 1 }],
  ] as const)(
    "enforces the %s record dimension",
    async (_name, secondSource, secondTarget, limit) => {
      const path = statePath();
      const time = controlledClock();
      const database = store(path, "quota-owner", time, {
        deliveryRecordsPerSource: 100,
        deliveryRecordsPerTarget: 100,
        deliveryRecordsPerWorkspace: 100,
        ...limit,
      });
      const token = await database.acquire();
      expect(await database.createPrepared(input(token, 1, time.now()))).toMatchObject({
        ok: true,
      });
      expect(
        await database.createPrepared(input(token, 2, time.now() + 1, secondSource, secondTarget)),
      ).toEqual({ ok: false, code: "quota_exceeded" });
      database.close();
    },
  );

  test.each([
    ["source", sourceA, targetB, { deliveriesPerSourceWindow: 1 }],
    ["target", sourceB, targetA, { deliveriesPerTargetWindow: 1 }],
    ["workspace", sourceB, targetB, { deliveriesPerWorkspaceWindow: 1 }],
  ] as const)(
    "enforces the %s rate dimension atomically",
    async (_name, secondSource, secondTarget, limit) => {
      const path = statePath();
      const time = controlledClock();
      const database = store(path, "rate-owner", time, {
        deliveryRecordsPerSource: 100,
        deliveryRecordsPerTarget: 100,
        deliveryRecordsPerWorkspace: 100,
        deliveriesPerSourceWindow: 100,
        deliveriesPerTargetWindow: 100,
        deliveriesPerWorkspaceWindow: 100,
        ...limit,
      });
      const token = await database.acquire();
      await database.createPrepared(input(token, 10, time.now()));
      expect(
        await database.createPrepared(input(token, 11, time.now() + 1, secondSource, secondTarget)),
      ).toEqual({ ok: false, code: "rate_limited" });
      database.close();
    },
  );

  test.each([
    ["source", sourceA, targetB, { retainedEnvelopeBytesPerSource: 60 }],
    ["target", sourceB, targetA, { retainedEnvelopeBytesPerTarget: 60 }],
    ["workspace", sourceB, targetB, { retainedEnvelopeBytesPerWorkspace: 60 }],
  ] as const)(
    "enforces aggregate retained-envelope bytes for the %s dimension",
    async (_name, secondSource, secondTarget, limit) => {
      const path = statePath();
      const time = controlledClock();
      const database = store(path, "byte-owner", time, {
        retainedEnvelopeBytesPerSource: 1_000,
        retainedEnvelopeBytesPerTarget: 1_000,
        retainedEnvelopeBytesPerWorkspace: 1_000,
        ...limit,
      });
      const token = await database.acquire();
      expect(await database.createPrepared(input(token, 12, time.now()))).toMatchObject({
        ok: true,
      });
      expect(
        await database.createPrepared(input(token, 13, time.now() + 1, secondSource, secondTarget)),
      ).toEqual({ ok: false, code: "quota_exceeded" });
      database.close();
    },
  );

  test("prunes at most one bounded batch of expired rate events during admission", async () => {
    const path = statePath();
    const time = controlledClock(200_000);
    const database = store(path, "prune-owner", time);
    const token = await database.acquire();
    const writer = new Database(database.databasePath, { strict: true });
    const insert = writer.prepare(
      `INSERT INTO delivery_rate_events(
         workspace_key, source_session_id, target_session_id, occurred_at_ms
       ) VALUES (?, ?, ?, ?)`,
    );
    const writeExpired = writer.transaction(() => {
      for (let index = 0; index < 101; index += 1) {
        insert.run(workspace, sourceA, targetA, 1);
      }
    });
    writeExpired.immediate();
    writer.close(true);
    expect(await database.createPrepared(input(token, 14, time.now()))).toMatchObject({ ok: true });
    const reader = new Database(database.databasePath, { readonly: true, strict: true });
    const expired = reader
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM delivery_rate_events WHERE occurred_at_ms = 1",
      )
      .get();
    expect(expired?.count).toBe(1);
    reader.close(true);
    database.close();
  });
});

describe("ownership epochs and startup recovery", () => {
  test("does not change shared pragmas while another owner is live", async () => {
    const path = statePath();
    const time = controlledClock();
    const first = store(path, "settings-owner", time, { databaseBytes: 8 * 1024 * 1024 });
    await first.acquire();
    const readSettings = async () => {
      const diagnostics = await first.readStorageDiagnostics();
      return { maximum: diagnostics.maxPageCount, journal: diagnostics.journalMode };
    };
    expect(await readSettings()).toEqual({ maximum: 2_048, journal: "wal" });
    const second = store(path, "different-settings", time, {
      databaseBytes: 16 * 1024 * 1024,
    });
    expect(await readSettings()).toEqual({ maximum: 2_048, journal: "wal" });
    await expect(second.acquire()).rejects.toThrow();
    expect(await readSettings()).toEqual({ maximum: 2_048, journal: "wal" });
    second.close();
    first.close();
  });

  test("uses monotonic local expiry across independent wall-clock jumps and delayed renewal", async () => {
    const path = statePath();
    const time = controlledClock();
    const first = store(path, "clock-owner", time);
    const token = await first.acquire();
    time.moveWall(-50_000);
    time.moveMonotonic(1_001);
    expect(await first.isCurrent(token)).toBeFalse();
    time.moveWall(51_101);
    const second = store(path, "clock-takeover", time);
    const next = await second.acquire();
    expect(Number(next)).toBe(Number(token) + 1);
    time.moveWall(-10_000);
    expect(await first.isCurrent(token)).toBeFalse();
    expect(() => second.close()).toThrow(StoreIntegrityError);
    first.close();

    const delayedPath = statePath();
    const delayedTime = controlledClock();
    const delayed = store(delayedPath, "delayed-renewal", delayedTime);
    const delayedToken = await delayed.acquire();
    delayedTime.moveMonotonic(1_500);
    expect(await delayed.isCurrent(delayedToken)).toBeFalse();
    await expect(delayed.acquire()).rejects.toThrow();
    delayed.close();
  });

  test("clean close allows immediate takeover and a stale closer does not checkpoint", async () => {
    const cleanPath = statePath();
    const cleanTime = controlledClock();
    const clean = store(cleanPath, "clean-owner", cleanTime);
    const cleanToken = await clean.acquire();
    clean.close();
    const immediate = store(cleanPath, "immediate-owner", cleanTime);
    expect(Number(await immediate.acquire())).toBe(Number(cleanToken) + 1);
    immediate.close();

    const stalePath = statePath();
    const staleTime = controlledClock();
    const stale = store(stalePath, "stale-closer", staleTime);
    await stale.acquire();
    staleTime.advance(1_101);
    const current = store(stalePath, "current-during-close", staleTime);
    await current.acquire();
    const blocker = new Database(current.databasePath, { strict: true });
    blocker.exec("BEGIN IMMEDIATE");
    expect(() => stale.close()).not.toThrow();
    blocker.exec("ROLLBACK");
    blocker.close(true);
    current.close();
  });

  test("returns one epoch to the owner, renews conservatively, and increments only on takeover", async () => {
    const path = statePath();
    const time = controlledClock();
    const first = store(path, "owner-one", time);
    const tokenOne = await first.acquire();
    expect(await Promise.all([first.acquire(), first.acquire()])).toEqual([tokenOne, tokenOne]);
    time.advance(400);
    expect(await first.isCurrent(tokenOne)).toBeTrue();

    const second = store(path, "owner-two", time);
    await expect(second.acquire()).rejects.toThrow();
    time.advance(1_200);
    const tokenTwo = await second.acquire();
    expect(Number(tokenTwo)).toBe(Number(tokenOne) + 1);
    expect(await first.isCurrent(tokenOne)).toBeFalse();
    second.close();
    first.close();
  });

  test("treats a crashed same-label store as a new generation and recovers its submission", async () => {
    const path = statePath();
    const time = controlledClock();
    const crashed = store(path, "shared-label", time);
    const crashedToken = await crashed.acquire();
    const record = input(crashedToken, 18, time.now());
    await crashed.createPrepared(record);
    await crashed.claimPrepared({
      fencingToken: crashedToken,
      workspaceKey: workspace,
      deliveryId: record.id,
      nowMs: time.now() + 1,
    });

    const restarted = store(path, "shared-label", time);
    await expect(restarted.acquire()).rejects.toThrow();
    time.advance(1_101);
    const restartedToken = await restarted.acquire();
    expect(Number(restartedToken)).toBe(Number(crashedToken) + 1);
    const barrier = await restarted.establish(restartedToken, {
      abort: new AbortController().signal,
    });
    const stale = await restarted.listRecoverable({
      fencingToken: restartedToken,
      workspaceKey: workspace,
      state: "submitting",
      limit: 10,
      excludeClaimedByToken: restartedToken,
      startupBarrier: barrier,
    });
    expect(stale.map((delivery) => delivery.id)).toEqual([record.id]);
    expect(
      await restarted.completeSubmission({
        fencingToken: restartedToken,
        workspaceKey: workspace,
        deliveryId: record.id,
        state: "admission_unknown",
        nowMs: time.now(),
      }),
    ).toMatchObject({ ok: true, delivery: { state: "admission_unknown" } });
    restarted.close();
    crashed.close();
  });

  test("rejects every stale-token mutation and query after ownership loss", async () => {
    const path = statePath();
    const time = controlledClock();
    const first = store(path, "stale-owner", time);
    const tokenOne = await first.acquire();
    const record = input(tokenOne, 20, time.now());
    await first.createPrepared(record);
    await first.claimPrepared({
      fencingToken: tokenOne,
      workspaceKey: workspace,
      deliveryId: record.id,
      nowMs: time.now() + 1,
    });
    time.advance(1_101);
    const second = store(path, "current-owner", time);
    await second.acquire();
    const transition = {
      fencingToken: tokenOne,
      workspaceKey: workspace,
      deliveryId: record.id,
      nowMs: time.now(),
    };
    expect(await first.createPrepared(input(tokenOne, 21, time.now()))).toEqual({
      ok: false,
      code: "ownership_lost",
    });
    expect(await first.cancelPrepared(transition)).toEqual({ ok: false, code: "ownership_lost" });
    expect(await first.claimPrepared(transition)).toEqual({ ok: false, code: "ownership_lost" });
    expect(await first.completeSubmission({ ...transition, state: "failed" })).toEqual({
      ok: false,
      code: "ownership_lost",
    });
    await expect(
      first.listRecoverable({
        fencingToken: tokenOne,
        workspaceKey: workspace,
        state: "prepared",
        limit: 10,
      }),
    ).rejects.toThrow(OwnershipLostFault);
    await expect(
      first.getForParticipant({
        workspaceKey: workspace,
        deliveryId: record.id,
        participantSessionId: sourceA,
      }),
    ).rejects.toThrow(OwnershipLostFault);
    await expect(
      first.establish(tokenOne, { abort: new AbortController().signal }),
    ).rejects.toThrow(OwnershipLostFault);
    await expect(
      first.garbageCollectMetadata({
        fencingToken: tokenOne,
        workspaceKey: workspace,
        limit: 1,
      }),
    ).rejects.toThrow(OwnershipLostFault);
    second.close();
    first.close();
  });
});

describe("workspace-scoped startup recovery", () => {
  test("keeps mixed message and request stale work blocked in either classification order", async () => {
    for (const requestFirst of [true, false]) {
      const path = statePath();
      const time = controlledClock();
      const first = store(path, `mixed-old-${requestFirst}`, time);
      const tokenOne = await first.acquire();
      const delivery = input(tokenOne, requestFirst ? 70 : 71, time.now());
      const request = await requestFixture(tokenOne, time.now(), sourceA, targetA, workspace);
      await first.createPrepared(delivery);
      await first.claimPrepared({
        fencingToken: tokenOne,
        workspaceKey: workspace,
        deliveryId: delivery.id,
        nowMs: time.now(),
      });
      await first.createPrepared(request);
      await first.claimPrepared({
        fencingToken: tokenOne,
        workspaceKey: workspace,
        requestId: request.request.id,
      });
      time.advance(1_101);
      const second = store(path, `mixed-new-${requestFirst}`, time);
      const tokenTwo = await second.acquire();
      await second.establish(tokenTwo, { abort: new AbortController().signal });
      const classifyRequest = () =>
        second.completeDelivery({
          fencingToken: tokenTwo,
          workspaceKey: workspace,
          requestId: request.request.id,
          outcome: "delivery_unknown",
        });
      const classifyDelivery = () =>
        second.completeSubmission({
          fencingToken: tokenTwo,
          workspaceKey: workspace,
          deliveryId: delivery.id,
          nowMs: time.now(),
          state: "admission_unknown",
        });
      await (requestFirst ? classifyRequest() : classifyDelivery());
      expect(
        await second.createPrepared(input(tokenTwo, requestFirst ? 72 : 73, time.now())),
      ).toEqual({ ok: false, code: "ownership_lost" });
      await (requestFirst ? classifyDelivery() : classifyRequest());
      expect(
        await second.createPrepared(input(tokenTwo, requestFirst ? 72 : 73, time.now())),
      ).toMatchObject({ ok: true });
      second.close();
      first.close();
    }
  });
});

describe("post-commit startup recovery barrier", () => {
  test("keeps message startup recovery blocked when post-write validation rolls back", async () => {
    const path = statePath();
    const time = controlledClock();
    const crashed = store(path, "message-rollback-old", time);
    const staleToken = await crashed.acquire();
    const stale = input(staleToken, 74, time.now());
    await crashed.createPrepared(stale);
    await crashed.claimPrepared({
      fencingToken: staleToken,
      workspaceKey: workspace,
      deliveryId: stale.id,
      nowMs: time.now(),
    });

    time.advance(1_101);
    const recovering = store(path, "message-rollback-new", time);
    const token = await recovering.acquire();
    const barrier = await recovering.establish(token, {
      abort: new AbortController().signal,
    });
    const fault = new Database(recovering.databasePath, { strict: true });
    fault.exec(`CREATE TRIGGER delete_classified_delivery
      AFTER UPDATE OF state ON deliveries
      BEGIN DELETE FROM deliveries WHERE id = NEW.id; END;`);
    fault.close(true);

    const classify = () =>
      recovering.completeSubmission({
        fencingToken: token,
        workspaceKey: workspace,
        deliveryId: stale.id,
        state: "admission_unknown",
        nowMs: time.now(),
      });
    expect(await classify()).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await recovering.listRecoverable({
        fencingToken: token,
        workspaceKey: workspace,
        state: "submitting",
        limit: 10,
        excludeClaimedByToken: token,
        startupBarrier: barrier,
      }),
    ).toMatchObject([{ id: stale.id, state: "submitting" }]);
    const ordinary = input(token, 75, time.now());
    expect(await recovering.createPrepared(ordinary)).toEqual({
      ok: false,
      code: "ownership_lost",
    });

    const repair = new Database(recovering.databasePath, { strict: true });
    repair.exec("DROP TRIGGER delete_classified_delivery");
    repair.close(true);
    expect(await classify()).toMatchObject({ ok: true, delivery: { state: "admission_unknown" } });
    expect(await recovering.createPrepared(ordinary)).toMatchObject({ ok: true });
    recovering.close();
    crashed.close();
  });

  test("keeps request startup recovery blocked when post-write validation rolls back", async () => {
    const path = statePath();
    const time = controlledClock();
    const crashed = store(path, "request-rollback-old", time);
    const staleToken = await crashed.acquire();
    const stale = await requestFixture(staleToken, time.now(), sourceA, targetA, workspace);
    await crashed.createPrepared(stale);
    await crashed.claimPrepared({
      fencingToken: staleToken,
      workspaceKey: workspace,
      requestId: stale.request.id,
    });

    time.advance(1_101);
    const recovering = store(path, "request-rollback-new", time);
    const token = await recovering.acquire();
    const barrier = await recovering.establish(token, {
      abort: new AbortController().signal,
    });
    const fault = new Database(recovering.databasePath, { strict: true });
    fault.exec(`CREATE TRIGGER delete_classified_request
      AFTER UPDATE OF delivery_state ON requests
      BEGIN DELETE FROM requests WHERE id = NEW.id; END;`);
    fault.close(true);

    const classify = () =>
      recovering.completeDelivery({
        fencingToken: token,
        workspaceKey: workspace,
        requestId: stale.request.id,
        outcome: "delivery_unknown",
      });
    expect(await classify()).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await recovering.listRecoverableRequests({
        fencingToken: token,
        workspaceKey: workspace,
        state: "submitting",
        limit: 10,
        excludeClaimedByToken: token,
        startupBarrier: barrier,
      }),
    ).toMatchObject([{ id: stale.request.id, deliveryState: "submitting" }]);
    const ordinary = await requestFixture(token, time.now(), sourceB, targetB, workspace);
    expect(await recovering.createPrepared(ordinary)).toEqual({
      ok: false,
      code: "ownership_lost",
    });

    const repair = new Database(recovering.databasePath, { strict: true });
    repair.exec("DROP TRIGGER delete_classified_request");
    repair.close(true);
    expect(await classify()).toMatchObject({
      ok: true,
      request: { deliveryState: "delivery_unknown" },
    });
    expect(await recovering.createPrepared(ordinary)).toMatchObject({ ok: true });
    recovering.close();
    crashed.close();
  });
});

describe("workspace-scoped recovery queries", () => {
  test("lists prepared records and only stale-token submitting records behind the barrier", async () => {
    const path = statePath();
    const time = controlledClock();
    const first = store(path, "recovery-old", time);
    const tokenOne = await first.acquire();
    const staleSubmitting = input(tokenOne, 30, time.now());
    const stillPrepared = input(tokenOne, 31, time.now() + 1);
    await first.createPrepared(staleSubmitting);
    await first.claimPrepared({
      fencingToken: tokenOne,
      workspaceKey: workspace,
      deliveryId: staleSubmitting.id,
      nowMs: time.now() + 2,
    });
    await first.createPrepared(stillPrepared);
    time.advance(1_101);
    first.close();

    const second = store(path, "recovery-current", time);
    const tokenTwo = await second.acquire();
    const currentSubmitting = input(tokenTwo, 32, time.now());
    expect(await second.createPrepared(currentSubmitting)).toEqual({
      ok: false,
      code: "ownership_lost",
    });
    await expect(
      second.listRecoverable({
        fencingToken: tokenTwo,
        workspaceKey: workspace,
        state: "submitting",
        limit: 10,
        excludeClaimedByToken: tokenTwo,
        startupBarrier: { established: true, fencingToken: tokenTwo },
      }),
    ).rejects.toThrow(OwnershipLostFault);
    const barrier = await second.establish(tokenTwo, { abort: new AbortController().signal });
    await expect(
      second.listRecoverable({
        fencingToken: tokenTwo,
        workspaceKey: workspace,
        state: "submitting",
        limit: 10,
        excludeClaimedByToken: tokenOne,
        startupBarrier: barrier,
      }),
    ).rejects.toThrow(OwnershipLostFault);
    const submitting = await second.listRecoverable({
      fencingToken: tokenTwo,
      workspaceKey: workspace,
      state: "submitting",
      limit: 10,
      excludeClaimedByToken: tokenTwo,
      startupBarrier: barrier,
    });
    expect(submitting.map((delivery) => delivery.id)).toEqual([staleSubmitting.id]);
    expect(
      await second.completeSubmission({
        fencingToken: tokenTwo,
        workspaceKey: workspace,
        deliveryId: staleSubmitting.id,
        state: "admission_unknown",
        nowMs: time.now() + 1,
      }),
    ).toMatchObject({ ok: true, delivery: { state: "admission_unknown" } });
    const preparedRecords = await second.listRecoverable({
      fencingToken: tokenTwo,
      workspaceKey: workspace,
      state: "prepared",
      limit: 10,
    });
    expect(preparedRecords.map((delivery) => delivery.id)).toEqual([stillPrepared.id]);
    await second.createPrepared(currentSubmitting);
    await second.claimPrepared({
      fencingToken: tokenTwo,
      workspaceKey: workspace,
      deliveryId: currentSubmitting.id,
      nowMs: time.now() + 2,
    });
    expect(
      await second.listRecoverable({
        fencingToken: tokenTwo,
        workspaceKey: workspace,
        state: "submitting",
        limit: 10,
        excludeClaimedByToken: tokenTwo,
        startupBarrier: barrier,
      }),
    ).toEqual([]);
    second.close();
  });
});

describe("fail-closed hydration and retention", () => {
  test("rejects a malformed persisted row without exposing payload", async () => {
    const path = statePath();
    const time = controlledClock();
    const database = store(path, "integrity-owner", time);
    const token = await database.acquire();
    const record = input(token, 40, time.now());
    await database.createPrepared(record);
    const corrupter = new Database(database.databasePath, { strict: true });
    corrupter.exec("PRAGMA ignore_check_constraints = ON");
    corrupter.run("UPDATE deliveries SET content_sha256 = ? WHERE id = ?", [
      "malformed",
      record.id,
    ]);
    corrupter.close(true);
    let error: unknown;
    try {
      await database.getForParticipant({
        workspaceKey: workspace,
        deliveryId: record.id,
        participantSessionId: sourceA,
      });
    } catch (cause: unknown) {
      error = cause;
    }
    expect(error).toBeInstanceOf(StoreIntegrityError);
    expect(String(error)).not.toContain("private-40");
    database.close();
  });

  test("logically deletes on cancellation and garbage-collects terminal metadata after 30 days", async () => {
    const path = statePath();
    const time = controlledClock(1_000);
    const database = store(path, "gc-owner", time);
    let token = await database.acquire();
    const old = input(token, 50, 1_000);
    const recent = input(token, 51, 1_001);
    const oldPrepared = input(token, 52, 1_000);
    await database.createPrepared(old);
    await database.cancelPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: old.id,
      nowMs: 1_002,
    });
    await database.createPrepared(recent);
    await database.createPrepared(oldPrepared);
    await database.cancelPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId: recent.id,
      nowMs: 1_003,
    });
    const reader = new Database(database.databasePath, { readonly: true, strict: true });
    expect(
      reader
        .query<{ envelope: string | null }, [string]>(
          "SELECT prepared_envelope AS envelope FROM deliveries WHERE id = ?",
        )
        .get(old.id)?.envelope,
    ).toBeNull();
    reader.close(true);
    const afterThirtyDays = 1_002 + 30 * 24 * 60 * 60 * 1_000;
    time.moveWall(afterThirtyDays - time.now());
    token = await database.acquire();
    expect(
      await database.garbageCollectMetadata({
        fencingToken: token,
        workspaceKey: workspace,
        limit: 1,
      }),
    ).toEqual({ ok: true, deletedDeliveries: 1, deletedRateEvents: 1 });
    expect(
      await database.getForParticipant({
        workspaceKey: workspace,
        deliveryId: old.id,
        participantSessionId: sourceA,
      }),
    ).toBeUndefined();
    expect(
      await database.getForParticipant({
        workspaceKey: workspace,
        deliveryId: recent.id,
        participantSessionId: sourceA,
      }),
    ).toBeDefined();
    expect(
      await database.getForParticipant({
        workspaceKey: workspace,
        deliveryId: oldPrepared.id,
        participantSessionId: sourceA,
      }),
    ).toMatchObject({ delivery: { state: "prepared" } });
    database.close();
  });
});
