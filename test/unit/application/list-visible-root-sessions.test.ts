import { describe, expect, test } from "bun:test";

import { listVisibleRootSessions } from "../../../src/application/list-visible-root-sessions";
import type {
  ActivityStatus,
  RootSessionObservation,
  SessionId,
  VisibleRootSessionPort,
} from "../../../src/domain/sessions";
import { validateSessionId } from "../../../src/domain/sessions";

function id(value: string): SessionId {
  const result = validateSessionId(value);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function session(input: {
  id: string;
  updatedAtMs: number;
  status?: ActivityStatus;
  isArchived?: boolean;
  title?: string;
}): RootSessionObservation {
  return {
    id: id(input.id),
    title: input.title ?? input.id,
    updatedAtMs: input.updatedAtMs,
    isArchived: input.isArchived ?? false,
    status: input.status ?? "idle",
    observedAtMs: 5000,
  };
}

function port(items: readonly RootSessionObservation[]): {
  readonly port: VisibleRootSessionPort;
  readonly requests: boolean[];
} {
  const requests: boolean[] = [];
  return {
    requests,
    port: {
      async readVisibleRoots(includeArchived): Promise<readonly RootSessionObservation[]> {
        requests.push(includeArchived);
        return items;
      },
    },
  };
}

describe("visible root session listing", () => {
  test("defaults to the 50 newest non-archived roots", async () => {
    const items = Array.from({ length: 55 }, (_, index) =>
      session({ id: `ses_${String(index).padStart(3, "0")}`, updatedAtMs: index }),
    );
    items.push(session({ id: "ses_archived", updatedAtMs: 1000, isArchived: true }));
    const fake = port(items);
    const result = await listVisibleRootSessions(fake.port);
    expect(fake.requests).toEqual([false]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(50);
    expect(String(result.value[0]?.id)).toBe("ses_054");
    expect(String(result.value.at(-1)?.id)).toBe("ses_005");
    expect(result.value.some((item) => item.id === "ses_archived")).toBe(false);
  });

  test("filters active status before applying the limit", async () => {
    const fake = port([
      session({ id: "ses_idleNew", updatedAtMs: 40 }),
      session({ id: "ses_busy", updatedAtMs: 30, status: "busy" }),
      session({ id: "ses_retry", updatedAtMs: 20, status: "retry" }),
      session({ id: "ses_idleOld", updatedAtMs: 10 }),
      session({ id: "ses_unknown", updatedAtMs: 50, status: "unknown" }),
    ]);
    const result = await listVisibleRootSessions(fake.port, { status: "active", limit: 2 });
    expect(result).toMatchObject({
      ok: true,
      value: [
        { id: "ses_busy", status: "busy", isActive: true, statusObservedAtMs: 5000 },
        { id: "ses_retry", status: "retry", isActive: true, statusObservedAtMs: 5000 },
      ],
    });
  });

  test("lists only idle when requested and includes archived only explicitly", async () => {
    const fake = port([
      session({ id: "ses_idle", updatedAtMs: 1 }),
      session({ id: "ses_archived", updatedAtMs: 2, isArchived: true }),
      session({ id: "ses_unknown", updatedAtMs: 3, status: "unknown" }),
    ]);
    const result = await listVisibleRootSessions(fake.port, {
      status: "idle",
      includeArchived: true,
    });
    expect(fake.requests).toEqual([true]);
    expect(result).toMatchObject({
      ok: true,
      value: [{ id: "ses_archived" }, { id: "ses_idle" }],
    });
  });

  test("sanitizes display titles without changing canonical IDs", async () => {
    const fake = port([
      session({ id: "ses_canonical", updatedAtMs: 1, title: "\u001b[31mTitle\u202e" }),
    ]);
    expect(await listVisibleRootSessions(fake.port)).toMatchObject({
      ok: true,
      value: [{ id: "ses_canonical", title: "Title", isActive: false }],
    });
  });

  test.each([0, 101, 1.5, Number.NaN])(
    "rejects invalid limit %s before native I/O",
    async (limit) => {
      const fake = port([]);
      expect(await listVisibleRootSessions(fake.port, { limit })).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments", retryable: false },
      });
      expect(fake.requests).toEqual([]);
    },
  );

  test("returns a safe retryable failure for native faults", async () => {
    const secret = "private native fault";
    const failing: VisibleRootSessionPort = {
      async readVisibleRoots(): Promise<readonly RootSessionObservation[]> {
        throw new Error(secret);
      },
    };
    const result = await listVisibleRootSessions(failing);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "native_unavailable",
        message: "Visible session state is temporarily unavailable.",
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
