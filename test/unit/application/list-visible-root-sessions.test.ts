import { describe, expect, test } from "bun:test";

import { listVisibleRootSessions } from "../../../src/application/list-visible-root-sessions";
import type {
  ActivityStatus,
  RootSessionObservation,
  SessionId,
  VisibleRootSessionPort,
} from "../../../src/domain/sessions";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function id(value: string): SessionId {
  const result = validateSessionId(value);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

const workspace = validateWorkspaceKey("workspace:one");
if (!workspace.ok) throw new Error("invalid workspace fixture");
const workspaceKey = workspace.value;
const sourceSessionId = id("ses_source");

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

function list(
  fake: ReturnType<typeof port>,
  query: Parameters<typeof listVisibleRootSessions>[2] = {},
  membership: "visible" | "hidden" | "fault" | "foreign" = "visible",
) {
  return listVisibleRootSessions(
    {
      sessions: fake.port,
      membership: {
        async readCurrentRoots(suppliedWorkspaceKey) {
          if (membership === "fault") throw new Error("private membership fault");
          if (membership === "foreign" || suppliedWorkspaceKey !== workspaceKey) {
            throw new Error("foreign workspace");
          }
          return {
            sourceVisible: membership === "visible",
            targetVisible: membership === "visible",
            sourceTitle: "Source",
          };
        },
      },
    },
    { workspaceKey, sourceSessionId },
    query,
  );
}

describe("visible root session listing", () => {
  test("defaults to the 50 newest non-archived roots", async () => {
    const items = Array.from({ length: 55 }, (_, index) =>
      session({ id: `ses_${String(index).padStart(3, "0")}`, updatedAtMs: index }),
    );
    items.push(session({ id: "ses_archived", updatedAtMs: 1000, isArchived: true }));
    const fake = port(items);
    const result = await list(fake);
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
    const result = await list(fake, { status: "active", limit: 2 });
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
    const result = await list(fake, {
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
    expect(await list(fake)).toMatchObject({
      ok: true,
      value: [{ id: "ses_canonical", title: "Title", isActive: false }],
    });
  });

  test.each([0, 101, 1.5, Number.NaN])(
    "rejects invalid limit %s before native I/O",
    async (limit) => {
      const fake = port([]);
      expect(await list(fake, { limit })).toMatchObject({
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
    const ports = {
      sessions: failing,
      membership: {
        async readCurrentRoots() {
          return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
        },
      },
    };
    const actual = await listVisibleRootSessions(ports, {
      workspaceKey,
      sourceSessionId,
    });
    expect(actual).toEqual({
      ok: false,
      error: {
        code: "native_unavailable",
        message: "Visible session state is temporarily unavailable.",
        retryable: true,
      },
    });
    expect(JSON.stringify(actual)).not.toContain(secret);
  });

  test.each(["archived", "deleted", "child"])(
    "rejects a caller that is currently %s without consulting limited list results",
    async () => {
      const fake = port([session({ id: "ses_other", updatedAtMs: 1 })]);
      expect(await list(fake, { limit: 1 }, "hidden")).toMatchObject({
        ok: false,
        error: { code: "caller_not_visible", retryable: false },
      });
      expect(fake.requests).toEqual([]);
    },
  );

  test("fails safely for foreign workspace context and membership faults", async () => {
    const fake = port([]);
    for (const classification of ["foreign", "fault"] as const) {
      const result = await list(fake, {}, classification);
      expect(result).toEqual({
        ok: false,
        error: {
          code: "native_unavailable",
          message: "Current session membership is unavailable.",
          retryable: true,
        },
      });
    }
    expect(fake.requests).toEqual([]);
  });

  test("passes the supplied workspace binding to membership and rejects a foreign context", async () => {
    const foreign = validateWorkspaceKey("workspace:foreign");
    if (!foreign.ok) throw new Error("invalid foreign workspace fixture");
    const foreignWorkspaceKey = foreign.value;
    const fake = port([]);
    const seen: string[] = [];
    const result = await listVisibleRootSessions(
      {
        sessions: fake.port,
        membership: {
          async readCurrentRoots(suppliedWorkspaceKey) {
            seen.push(suppliedWorkspaceKey);
            if (suppliedWorkspaceKey !== workspaceKey) throw new Error("foreign binding");
            return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
          },
        },
      },
      { workspaceKey: foreignWorkspaceKey, sourceSessionId },
    );
    expect(seen).toEqual(["workspace:foreign"]);
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(fake.requests).toEqual([]);
  });

  test("validates host-canonical caller ID before membership I/O", async () => {
    const fake = port([]);
    const result = await listVisibleRootSessions(
      {
        sessions: fake.port,
        membership: {
          async readCurrentRoots() {
            throw new Error("must not run");
          },
        },
      },
      { workspaceKey, sourceSessionId: "foreign" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(fake.requests).toEqual([]);
  });
});
