import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { StoreIntegrityError } from "../../../../src/adapters/store/store-types";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

interface LeaseRow {
  readonly fencingToken: number;
  readonly acquiredWallMs: number;
  readonly renewedWallMs: number;
  readonly expiresWallMs: number;
  readonly releasedWallMs: number | null;
}

const roots: string[] = [];
const workspaceResult = validateWorkspaceKey("workspace:ownership-clock");
if (!workspaceResult.ok) throw new Error("invalid ownership test workspace");
const workspace = workspaceResult.value;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "communicator-ownership-clock-"));
  roots.push(root);
  return join(root, "state");
}

function clock(initialWallMs = 100_000, initialMonotonicMs = initialWallMs) {
  let wallMs = initialWallMs;
  let monotonicMs = initialMonotonicMs;
  return {
    wall: () => wallMs,
    monotonic: () => monotonicMs,
    setWall: (value: number) => {
      wallMs = value;
    },
    advanceMonotonic: (milliseconds: number) => {
      monotonicMs += milliseconds;
    },
  };
}

function openStore(path: string, ownerId: string, time: ReturnType<typeof clock>) {
  return new LinuxBunSqliteStore({
    stateDirectory: path,
    workspaceKey: workspace,
    ownerId,
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: time.wall,
    nowMonotonicMs: time.monotonic,
  });
}

function leaseRow(databasePath: string): LeaseRow {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const row = database
      .query<LeaseRow, []>(
        `SELECT fencing_token AS fencingToken, acquired_wall_ms AS acquiredWallMs,
           renewed_wall_ms AS renewedWallMs, expires_wall_ms AS expiresWallMs,
           released_wall_ms AS releasedWallMs FROM ownership WHERE singleton = 1`,
      )
      .get();
    if (!row) throw new Error("missing ownership fixture");
    return row;
  } finally {
    database.close(true);
  }
}

describe("ownership clock regression", () => {
  test("renews a live monotonic lease without regressing persisted wall timestamps", async () => {
    const path = statePath();
    const time = clock();
    const owner = openStore(path, "renew-owner", time);
    const token = await owner.acquire();
    const before = leaseRow(owner.databasePath);

    time.setWall(50_000);
    time.advanceMonotonic(400);
    expect(await owner.isCurrent(token)).toBeTrue();
    expect(leaseRow(owner.databasePath)).toEqual(before);

    owner.close();
  });

  test("reacquires the same live epoch without regressing persisted wall timestamps", async () => {
    const path = statePath();
    const time = clock();
    const owner = openStore(path, "reacquire-owner", time);
    const token = await owner.acquire();
    const before = leaseRow(owner.databasePath);

    time.setWall(75_000);
    expect(await owner.acquire()).toBe(token);
    expect(leaseRow(owner.databasePath)).toEqual(before);

    owner.close();
  });

  test("releases after a backward jump with a valid non-regressing timestamp", async () => {
    const path = statePath();
    const time = clock();
    const owner = openStore(path, "release-owner", time);
    await owner.acquire();
    const before = leaseRow(owner.databasePath);

    time.setWall(25_000);
    expect(() => owner.close()).not.toThrow();
    const released = leaseRow(owner.databasePath);
    expect(released.releasedWallMs).toBe(before.renewedWallMs);
    expect(released.releasedWallMs).toBeGreaterThanOrEqual(released.acquiredWallMs);
    expect(released.releasedWallMs).toBeLessThanOrEqual(released.expiresWallMs);
  });

  test("takes over a released lease without regressing its persisted timeline", async () => {
    const path = statePath();
    const time = clock();
    const first = openStore(path, "released-owner", time);
    const firstToken = await first.acquire();
    first.close();
    const released = leaseRow(first.databasePath);

    time.setWall(50_000);
    const second = openStore(path, "released-successor", time);
    const secondToken = await second.acquire();
    const acquired = leaseRow(second.databasePath);
    expect(Number(secondToken)).toBe(Number(firstToken) + 1);
    expect(acquired.acquiredWallMs).toBeGreaterThanOrEqual(released.expiresWallMs);
    expect(acquired.renewedWallMs).toBeGreaterThanOrEqual(acquired.acquiredWallMs);
    expect(acquired.expiresWallMs).toBeGreaterThan(acquired.renewedWallMs);

    second.close();
  });

  test("keeps monotonic authority local and wall-clock takeover conservative", async () => {
    const path = statePath();
    const time = clock();
    const owner = openStore(path, "live-owner", time);
    const token = await owner.acquire();
    time.setWall(10_000);
    time.advanceMonotonic(400);
    expect(await owner.isCurrent(token)).toBeTrue();

    const contender = openStore(path, "blocked-contender", time);
    await expect(contender.acquire()).rejects.toThrow();

    time.setWall(101_001);
    expect(await owner.isCurrent(token)).toBeFalse();
    await expect(contender.acquire()).rejects.toThrow();
    time.setWall(101_101);
    const nextToken = await contender.acquire();
    expect(Number(nextToken)).toBe(Number(token) + 1);
    expect(await owner.isCurrent(token)).toBeFalse();

    contender.close();
    owner.close();
  });

  test("fails closed before persisting an overflowing lease timestamp", async () => {
    const path = statePath();
    const time = clock(Number.MAX_SAFE_INTEGER - 500, 1_000);
    const owner = openStore(path, "overflow-owner", time);

    await expect(owner.acquire()).rejects.toThrow(StoreIntegrityError);
    const database = new Database(owner.databasePath, { readonly: true, strict: true });
    try {
      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM ownership").get()
          ?.count,
      ).toBe(0);
    } finally {
      database.close(true);
    }
    owner.close();
  });
});
