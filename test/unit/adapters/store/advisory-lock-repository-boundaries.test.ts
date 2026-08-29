import { describe, expect, test } from "bun:test";

import { AdvisoryLockRepository } from "../../../../src/adapters/store/advisory-lock-repository";
import { type StoreContext, StoreIntegrityError } from "../../../../src/adapters/store/store-types";
import { advisoryLockPolicy } from "../../../../src/domain/advisory-locks";
import { validateAdvisoryLockId } from "../../../../src/domain/generated-ids";
import { OwnershipLostFault, validateFencingToken } from "../../../../src/domain/ownership";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:repository-locks"));
const foreignWorkspace = value(validateWorkspaceKey("workspace:foreign"));
const token = value(validateFencingToken(3));
const holderSessionId = value(validateSessionId("ses_holder"));
const lockId = value(validateAdvisoryLockId(`lck_${"1".repeat(32)}`));
const secondLockId = value(validateAdvisoryLockId(`lck_${"2".repeat(32)}`));

const row = Object.freeze({
  lockId,
  holderSessionId,
  title: "Schema migration",
  description: "Coordinate migration work.",
  instructions: "Ask the holder before edits.",
  createdAtMs: 100,
  renewedAtMs: 100,
  expiresAtMs: 2_000,
});

interface DatabaseBehavior {
  get?: (sql: string, parameters: readonly unknown[]) => unknown;
  all?: (sql: string, parameters: readonly unknown[]) => unknown[];
  run?: (sql: string, parameters: readonly unknown[]) => { changes: number };
  transactionFault?: unknown;
}

function fixture(behavior: DatabaseBehavior = {}, nowWallMs = 1_000) {
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const database = {
    transaction: (operation: () => unknown) => ({
      immediate: () => {
        if (behavior.transactionFault !== undefined) throw behavior.transactionFault;
        return operation();
      },
    }),
    query: (sql: string) => ({
      get: (...parameters: unknown[]) => {
        statements.push({ sql, parameters });
        if (sql.includes("pragma_page_count")) return { value: 1 };
        if (sql.includes("pragma_freelist_count")) return { value: 0 };
        return behavior.get?.(sql, parameters);
      },
      all: (...parameters: unknown[]) => {
        statements.push({ sql, parameters });
        return behavior.all?.(sql, parameters) ?? [];
      },
    }),
    run: (sql: string, parameters: readonly unknown[]) => {
      statements.push({ sql, parameters });
      return behavior.run?.(sql, parameters) ?? { changes: 1 };
    },
  };
  const context = {
    database,
    workspaceKey,
    leaseDurationMs: 30_000,
    maximumPageCount: 10,
    nowWallMs: () => nowWallMs,
  } as unknown as StoreContext;
  const repository = new AdvisoryLockRepository(context, {
    assertOrdinaryWorkAllowed: () => undefined,
  } as never);
  return { repository, statements };
}

function publishInput() {
  return {
    fencingToken: token,
    workspaceKey,
    lockId,
    holderSessionId,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    ttlSeconds: 1,
  };
}

describe("advisory lock repository strict boundaries", () => {
  test("rejects every malformed publish field before ownership or SQL", () => {
    const malformed = [
      { workspaceKey: foreignWorkspace },
      { lockId: "bad" },
      { holderSessionId: "bad" },
      { title: "" },
      { description: 1 },
      { instructions: null },
      { ttlSeconds: 0 },
    ];
    for (const override of malformed) {
      const setup = fixture();
      expect(setup.repository.publish({ ...publishInput(), ...override } as never)).toEqual({
        ok: false,
        code: "state_conflict",
      });
      expect(setup.statements).toHaveLength(0);
    }
  });

  test("classifies malformed quota aggregates, quota exhaustion, overflow, and storage faults", () => {
    for (const count of [undefined, -1, 1.5]) {
      const setup = fixture({
        get: (sql) => (sql.includes("count(*) AS count") ? { count } : undefined),
      });
      expect(setup.repository.publish(publishInput())).toEqual({
        ok: false,
        code: "state_conflict",
      });
    }
    const quota = fixture({
      get: (sql) => (sql.includes("count(*) AS count") ? { count: 1_024 } : undefined),
    });
    expect(quota.repository.publish(publishInput())).toEqual({ ok: false, code: "quota_exceeded" });

    const overflow = fixture(
      { get: (sql) => (sql.includes("count(*) AS count") ? { count: 0 } : undefined) },
      Number.MAX_SAFE_INTEGER,
    );
    expect(overflow.repository.publish(publishInput())).toEqual({
      ok: false,
      code: "state_conflict",
    });

    for (const [fault, code] of [
      [new OwnershipLostFault("stale"), "ownership_lost"],
      [new Error("disk"), "storage_unavailable"],
      [new StoreIntegrityError("corrupt"), "state_conflict"],
    ] as const) {
      const setup = fixture({ transactionFault: fault });
      expect(setup.repository.publish(publishInput())).toEqual({ ok: false, code });
    }
  });

  test("hydrates bounded cursor pages and rejects malformed stored rows", () => {
    const first = fixture({ all: () => [row, { ...row, lockId: secondLockId }] });
    expect(first.repository.list({ fencingToken: token, workspaceKey, limit: 2 })).toEqual({
      locks: [row, { ...row, lockId: secondLockId }],
      nextCursor: { createdAtMs: row.createdAtMs, lockId: secondLockId },
    });
    const cursor = { createdAtMs: 101, lockId: secondLockId };
    const second = fixture({ all: () => [row] });
    expect(second.repository.list({ fencingToken: token, workspaceKey, limit: 2, cursor })).toEqual(
      {
        locks: [row],
      },
    );
    expect(
      second.statements.some(({ parameters }) => parameters.includes(cursor.createdAtMs)),
    ).toBe(true);

    const malformed = fixture({ all: () => [{ ...row, expiresAtMs: row.renewedAtMs }] });
    expect(() =>
      malformed.repository.list({ fencingToken: token, workspaceKey, limit: 1 }),
    ).toThrow(StoreIntegrityError);
  });
});

describe("advisory lock repository maintenance boundaries", () => {
  test("validates list, cleanup, and schedule contracts at the storage boundary", () => {
    for (const input of [
      { workspaceKey: foreignWorkspace, limit: 1 },
      { workspaceKey, limit: 0 },
      { workspaceKey, limit: 1.5 },
      { workspaceKey, limit: advisoryLockPolicy.maximumListLimit + 1 },
      { workspaceKey, limit: 1, cursor: { createdAtMs: -1, lockId } },
      { workspaceKey, limit: 1, cursor: { createdAtMs: 1, lockId: "bad" } },
    ]) {
      expect(() => fixture().repository.list({ fencingToken: token, ...input } as never)).toThrow(
        StoreIntegrityError,
      );
    }

    for (const input of [
      { workspaceKey: foreignWorkspace, limit: 1 },
      { workspaceKey, limit: 0 },
      { workspaceKey, limit: 1.5 },
      { workspaceKey, limit: advisoryLockPolicy.maximumCleanupLimit + 1 },
    ]) {
      expect(() =>
        fixture().repository.cleanupExpired({ fencingToken: token, ...input } as never),
      ).toThrow(StoreIntegrityError);
    }
    expect(
      fixture({ run: () => ({ changes: 2 }) }).repository.cleanupExpired({
        fencingToken: token,
        workspaceKey,
        limit: 2,
      }),
    ).toEqual({ deleted: 2 });

    expect(() =>
      fixture().repository.readNextExpiry({ fencingToken: token, workspaceKey: foreignWorkspace }),
    ).toThrow(StoreIntegrityError);
    expect(fixture().repository.readNextExpiry({ fencingToken: token, workspaceKey })).toEqual({
      storeObservedAtMs: 1_000,
      maximumSleepMs: 10_000,
    });
    for (const expiresAtMs of [-1, 1.5]) {
      const setup = fixture({
        get: (sql) => (sql.includes("expires_at_ms AS expiresAtMs") ? { expiresAtMs } : undefined),
      });
      expect(() => setup.repository.readNextExpiry({ fencingToken: token, workspaceKey })).toThrow(
        StoreIntegrityError,
      );
    }
    expect(
      fixture({
        get: (sql) =>
          sql.includes("expires_at_ms AS expiresAtMs") ? { expiresAtMs: 2_000 } : undefined,
      }).repository.readNextExpiry({ fencingToken: token, workspaceKey }),
    ).toEqual({ storeObservedAtMs: 1_000, maximumSleepMs: 10_000, nextExpiryAtMs: 2_000 });
  });

  test("renew and release fail closed on malformed identity, overflow, races, and corrupt rows", () => {
    for (const input of [
      { workspaceKey: foreignWorkspace },
      { lockId: "bad" },
      { holderSessionId: "bad" },
      { ttlSeconds: 0 },
    ]) {
      expect(
        fixture().repository.renew({
          fencingToken: token,
          workspaceKey,
          lockId,
          holderSessionId,
          ttlSeconds: 1,
          ...input,
        } as never),
      ).toEqual({ ok: false, code: "state_conflict" });
    }
    expect(
      fixture({}, Number.MAX_SAFE_INTEGER).repository.renew({
        fencingToken: token,
        workspaceKey,
        lockId,
        holderSessionId,
        ttlSeconds: 1,
      }),
    ).toEqual({ ok: false, code: "not_found_or_unauthorized" });
    expect(
      fixture({ run: () => ({ changes: 0 }) }).repository.renew({
        fencingToken: token,
        workspaceKey,
        lockId,
        holderSessionId,
        ttlSeconds: 1,
      }),
    ).toEqual({ ok: false, code: "not_found_or_unauthorized" });

    expect(
      fixture().repository.release({
        fencingToken: token,
        workspaceKey: foreignWorkspace,
        lockId,
        holderSessionId,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      fixture().repository.release({ fencingToken: token, workspaceKey, lockId, holderSessionId }),
    ).toEqual({ ok: false, code: "not_found_or_unauthorized" });
    expect(
      fixture({ get: () => row, run: () => ({ changes: 0 }) }).repository.release({
        fencingToken: token,
        workspaceKey,
        lockId,
        holderSessionId,
      }),
    ).toEqual({ ok: false, code: "not_found_or_unauthorized" });
    expect(() =>
      fixture({ get: () => ({ ...row, title: "" }) }).repository.release({
        fencingToken: token,
        workspaceKey,
        lockId,
        holderSessionId,
      }),
    ).not.toThrow();
    expect(
      fixture({ get: () => ({ ...row, title: "" }) }).repository.release({
        fencingToken: token,
        workspaceKey,
        lockId,
        holderSessionId,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
  });
});
