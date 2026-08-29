import { describe, expect, test } from "bun:test";
import type { AdvisoryLockPersistencePort } from "../../../src/application/advisory-lock-ports";
import {
  decodeAdvisoryLockCursor,
  encodeAdvisoryLockCursor,
  listAdvisoryLocks,
  publishAdvisoryLock,
  releaseAdvisoryLock,
  renewAdvisoryLock,
} from "../../../src/application/advisory-lock-use-cases";
import type { AdvisoryLock } from "../../../src/domain/advisory-locks";
import { validateAdvisoryLockId } from "../../../src/domain/generated-ids";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("Invalid fixture.");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:locks"));
const fencingToken = value(validateFencingToken(7));
const caller = value(validateSessionId("ses_caller"));
const lockId = value(validateAdvisoryLockId(`lck_${"a".repeat(32)}`));
const lock: AdvisoryLock = Object.freeze({
  lockId,
  holderSessionId: caller,
  title: "Database migration",
  description: "Coordinates the migration.",
  instructions: "Ask before changing schema.",
  createdAtMs: 1_700_000_000_000,
  renewedAtMs: 1_700_000_001_000,
  expiresAtMs: 1_700_000_061_000,
});

function fixture(visible = true) {
  const calls: Array<Record<string, unknown>> = [];
  let wakes = 0;
  const ownershipLosses: string[] = [];
  const store: AdvisoryLockPersistencePort = {
    publish: async (input) => {
      calls.push(input);
      return {
        ok: true,
        lock: { ...lock, lockId: input.lockId, holderSessionId: input.holderSessionId },
      };
    },
    list: async (input) => {
      calls.push(input);
      return { locks: [lock], nextCursor: { createdAtMs: lock.createdAtMs, lockId } };
    },
    renew: async (input) => {
      calls.push(input);
      return { ok: true, lock: { ...lock, holderSessionId: input.holderSessionId } };
    },
    release: async (input) => {
      calls.push(input);
      return { ok: true, lock: { ...lock, holderSessionId: input.holderSessionId } };
    },
    cleanupExpired: async () => ({ deleted: 0 }),
    readNextExpiry: async () => ({ storeObservedAtMs: 1, maximumSleepMs: 1 }),
  };
  return {
    calls,
    wakes: () => wakes,
    ports: {
      readiness: {
        fencingToken,
        assertReady: () => undefined,
        ownershipLost: () => ownershipLosses.push("ownership_lost"),
      },
      membership: {
        readCurrentRoots: async (_workspace: unknown, source: unknown, target: unknown) => {
          calls.push({ source, target, membership: true });
          return { sourceTitle: "Caller", sourceVisible: visible, targetVisible: visible };
        },
      },
      locks: store,
      ids: { advisoryLockId: () => lockId },
      wake: {
        wakeAdvisoryLockExpiry: () => {
          wakes += 1;
        },
      },
      notifications: {
        notifyAdvisoryLockMutation: async () => ({ eligible: 2, admitted: 1, unknown: 1 }),
      },
    },
    context: { workspaceKey, fencingToken, callerSessionId: caller },
    ownershipLosses,
  };
}

describe("advisory lock use cases", () => {
  test("publishes with caller-derived holder identity and runs non-fatal post-commit hooks", async () => {
    const setup = fixture();
    const result = await publishAdvisoryLock(setup.ports, setup.context, {
      ttlSeconds: 60,
      title: "Database migration",
      description: "Coordinates the migration.",
      instructions: "Ask first.",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { notification: { eligible: 2, admitted: 1, unknown: 1 } },
    });
    expect(setup.calls[0]).toEqual({ source: caller, target: caller, membership: true });
    expect(setup.calls[1]).toMatchObject({ holderSessionId: caller, workspaceKey, lockId });
    expect(setup.wakes()).toBe(1);
  });

  test("checks visibility before every operation and never reaches persistence for an invisible caller", async () => {
    const setup = fixture(false);
    const operations = [
      () => listAdvisoryLocks(setup.ports, setup.context, {}),
      () =>
        publishAdvisoryLock(setup.ports, setup.context, {
          ttlSeconds: 1,
          title: "x",
          description: "x",
          instructions: "x",
        }),
      () => renewAdvisoryLock(setup.ports, setup.context, { lockId, ttlSeconds: 1 }),
      () => releaseAdvisoryLock(setup.ports, setup.context, { lockId }),
    ];
    for (const operation of operations) {
      expect(await operation()).toMatchObject({ ok: false, error: { code: "caller_not_visible" } });
    }
    expect(setup.calls).toHaveLength(4);
    expect(setup.calls.every((call) => call.membership === true)).toBe(true);
  });

  test("derives renew and release ownership exclusively from the tool caller", async () => {
    const setup = fixture();
    expect(
      await renewAdvisoryLock(setup.ports, setup.context, { lockId, ttlSeconds: 30 }),
    ).toMatchObject({
      ok: true,
    });
    expect(await releaseAdvisoryLock(setup.ports, setup.context, { lockId })).toMatchObject({
      ok: true,
    });
    expect(setup.wakes()).toBe(2);
    expect(setup.calls.filter((call) => "holderSessionId" in call)).toEqual([
      expect.objectContaining({ holderSessionId: caller }),
      expect.objectContaining({ holderSessionId: caller }),
    ]);
  });

  test("uses a strict, workspace-free, stable opaque cursor", async () => {
    const encoded = encodeAdvisoryLockCursor({ createdAtMs: lock.createdAtMs, lockId });
    expect(encoded).not.toContain("workspace");
    expect(decodeAdvisoryLockCursor(encoded)).toEqual({ createdAtMs: lock.createdAtMs, lockId });
    expect(encodeAdvisoryLockCursor(decodeAdvisoryLockCursor(encoded) as never)).toBe(encoded);
    for (const malformed of ["", "=", "a".repeat(257), Buffer.from("{}").toString("base64url")]) {
      expect(decodeAdvisoryLockCursor(malformed)).toBeUndefined();
    }
    const setup = fixture();
    expect(
      await listAdvisoryLocks(setup.ports, setup.context, { cursor: "malformed" }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });

  test("keeps committed mutations successful when notification delivery fails", async () => {
    const setup = fixture();
    setup.ports.notifications.notifyAdvisoryLockMutation = async () => {
      throw new Error("native unavailable");
    };
    expect(await releaseAdvisoryLock(setup.ports, setup.context, { lockId })).toEqual({
      ok: true,
      value: { lock, notification: { eligible: 0, admitted: 0, unknown: 0 } },
    });
  });

  test("stops readiness when persistence returns ownership loss", async () => {
    const setup = fixture();
    setup.ports.locks.publish = async () => ({ ok: false, code: "ownership_lost" });
    setup.ports.locks.renew = async () => ({ ok: false, code: "ownership_lost" });
    setup.ports.locks.release = async () => ({ ok: false, code: "ownership_lost" });

    const results = [
      await publishAdvisoryLock(setup.ports, setup.context, {
        ttlSeconds: 60,
        title: "Database migration",
        description: "Coordinates the migration.",
        instructions: "Ask first.",
      }),
      await renewAdvisoryLock(setup.ports, setup.context, { lockId, ttlSeconds: 60 }),
      await releaseAdvisoryLock(setup.ports, setup.context, { lockId }),
    ];

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    }
    expect(setup.ownershipLosses).toEqual(["ownership_lost", "ownership_lost", "ownership_lost"]);
  });
});

describe("advisory lock strict failure boundaries", () => {
  test("rejects malformed callers, visibility faults, and every malformed mutation argument", async () => {
    const malformedCaller = fixture();
    malformedCaller.context.callerSessionId = "not-a-session" as never;
    expect(
      await listAdvisoryLocks(malformedCaller.ports, malformedCaller.context, {}),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(malformedCaller.calls).toHaveLength(0);

    const visibilityFault = fixture();
    visibilityFault.ports.membership.readCurrentRoots = async () => {
      throw new Error("visibility backend unavailable");
    };
    expect(
      await listAdvisoryLocks(visibilityFault.ports, visibilityFault.context, {}),
    ).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible", retryable: true },
    });

    const malformedPublish = [
      { ttlSeconds: 0, title: "x", description: "x", instructions: "x" },
      { ttlSeconds: 1, title: "", description: "x", instructions: "x" },
      { ttlSeconds: 1, title: "x", description: 1, instructions: "x" },
      { ttlSeconds: 1, title: "x", description: "x", instructions: null },
      { ttlSeconds: 1, title: "x", description: "", instructions: "x" },
      { ttlSeconds: 1, title: "x", description: "x", instructions: "" },
    ];
    for (const command of malformedPublish) {
      const setup = fixture();
      expect(await publishAdvisoryLock(setup.ports, setup.context, command)).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments" },
      });
      expect(setup.calls).toHaveLength(1);
    }

    for (const command of [
      { lockId: "bad", ttlSeconds: 1 },
      { lockId, ttlSeconds: 0 },
    ]) {
      const setup = fixture();
      expect(await renewAdvisoryLock(setup.ports, setup.context, command)).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments" },
      });
    }
    const setup = fixture();
    expect(await releaseAdvisoryLock(setup.ports, setup.context, { lockId: "bad" })).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });

  test("strictly validates cursor structure, canonical encoding, and list limits", async () => {
    expect(() => encodeAdvisoryLockCursor({ createdAtMs: -1, lockId })).toThrow(TypeError);
    expect(() => encodeAdvisoryLockCursor({ createdAtMs: 1, lockId: "bad" as never })).toThrow(
      TypeError,
    );
    const encodedJson = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const malformed of [
      7,
      encodedJson(null),
      encodedJson([]),
      encodedJson({ v: 2, c: 1, l: lockId }),
      encodedJson({ v: 1, c: -1, l: lockId }),
      encodedJson({ v: 1, c: 1, l: "bad" }),
      encodedJson({ v: 1, c: 1, l: lockId, extra: true }),
      Buffer.from("not-json").toString("base64url"),
      Buffer.from(`{ "v":1,"c":1,"l":"${lockId}" }`).toString("base64url"),
    ]) {
      expect(decodeAdvisoryLockCursor(malformed)).toBeUndefined();
    }

    for (const limit of [0, 101, 1.5, "2"]) {
      const setup = fixture();
      expect(await listAdvisoryLocks(setup.ports, setup.context, { limit })).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments" },
      });
    }

    const setup = fixture();
    setup.ports.locks.list = async (input) => {
      setup.calls.push(input);
      return { locks: [] };
    };
    expect(await listAdvisoryLocks(setup.ports, setup.context, {})).toEqual({
      ok: true,
      value: { locks: [] },
    });
    expect(setup.calls[1]).toMatchObject({ limit: 50 });
    expect(setup.calls[1]).not.toHaveProperty("cursor");
  });

  test("maps quota, authorization, storage, and thrown ownership failures without leaking causes", async () => {
    const quota = fixture();
    quota.ports.locks.publish = async () => ({ ok: false, code: "quota_exceeded" });
    expect(
      await publishAdvisoryLock(quota.ports, quota.context, {
        ttlSeconds: 1,
        title: "x",
        description: "x",
        instructions: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "quota_exceeded", retryable: false } });

    const unauthorized = fixture();
    unauthorized.ports.locks.renew = async () => ({
      ok: false,
      code: "not_found_or_unauthorized",
    });
    expect(
      await renewAdvisoryLock(unauthorized.ports, unauthorized.context, { lockId, ttlSeconds: 1 }),
    ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });

    const unavailable = fixture();
    unavailable.ports.locks.release = async () => ({ ok: false, code: "state_conflict" });
    expect(
      await releaseAdvisoryLock(unavailable.ports, unavailable.context, { lockId }),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable", retryable: true } });

    for (const cause of [new Error("disk secret"), new OwnershipLostFault("lease secret")]) {
      const setup = fixture();
      setup.ports.locks.list = async () => {
        throw cause;
      };
      const result = await listAdvisoryLocks(setup.ports, setup.context, {});
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        },
      });
    }
  });

  test("handles unavailable or failing IDs and treats post-commit hooks as best effort", async () => {
    const unavailableIds = fixture();
    unavailableIds.ports.ids = undefined as never;
    expect(
      await publishAdvisoryLock(unavailableIds.ports, unavailableIds.context, {
        ttlSeconds: 1,
        title: "x",
        description: "x",
        instructions: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

    const failingIds = fixture();
    failingIds.ports.ids.advisoryLockId = () => {
      throw new Error("entropy unavailable");
    };
    expect(
      await publishAdvisoryLock(failingIds.ports, failingIds.context, {
        ttlSeconds: 1,
        title: "x",
        description: "x",
        instructions: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

    const noHooks = fixture();
    noHooks.ports.wake = undefined as never;
    noHooks.ports.notifications = undefined as never;
    expect(await releaseAdvisoryLock(noHooks.ports, noHooks.context, { lockId })).toMatchObject({
      ok: true,
      value: { notification: { eligible: 0, admitted: 0, unknown: 0 } },
    });

    const badHooks = fixture();
    badHooks.ports.wake.wakeAdvisoryLockExpiry = () => {
      throw new Error("wake failed after commit");
    };
    for (const summary of [
      { eligible: -1, admitted: 0, unknown: 0 },
      { eligible: 1, admitted: 2, unknown: 0 },
      { eligible: 101, admitted: 0, unknown: 0 },
      { eligible: 1, admitted: 0.5, unknown: 0 },
    ]) {
      badHooks.ports.notifications.notifyAdvisoryLockMutation = async () => summary;
      expect(await releaseAdvisoryLock(badHooks.ports, badHooks.context, { lockId })).toMatchObject(
        {
          ok: true,
          value: { notification: { eligible: 0, admitted: 0, unknown: 0 } },
        },
      );
    }
  });
});
