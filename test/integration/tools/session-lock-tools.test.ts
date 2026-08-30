import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxBunSqliteStore } from "../../../src/adapters/store/sqlite-store";
import { validateAdvisoryLockId } from "../../../src/domain/generated-ids";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import {
  createSessionLockListTool,
  createSessionLockPublishTool,
  createSessionLockReleaseTool,
  createSessionLockRenewTool,
} from "../../../src/tools/session-locks";

function value<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("Invalid fixture.");
  return result.value;
}

const roots: string[] = [];
const stores: LinuxBunSqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session lock tool integration", () => {
  test("publishes, lists, renews, and releases through the composed application boundary", async () => {
    const workspaceKey = value(validateWorkspaceKey("workspace:lock-tools"));
    const holder = value(validateSessionId("ses_holder"));
    const other = value(validateSessionId("ses_other"));
    const root = mkdtempSync(join(tmpdir(), "communicator-lock-tools-"));
    roots.push(root);
    const store = new LinuxBunSqliteStore({
      stateDirectory: join(root, "state"),
      workspaceKey,
      nowWallMs: () => 1_700_000_000_000,
      nowMonotonicMs: () => 1,
    });
    stores.push(store);
    const fencingToken = await store.acquire();
    let nextId = 0;
    const ports = {
      readiness: { fencingToken, assertReady: () => undefined },
      membership: {
        readCurrentRoots: async () => ({
          sourceTitle: "Visible",
          sourceVisible: true,
          targetVisible: true,
        }),
      },
      locks: store,
      ids: {
        advisoryLockId: () => {
          nextId += 1;
          return value(validateAdvisoryLockId(`lck_${nextId.toString(16).padStart(32, "0")}`));
        },
      },
    };
    const scope = { workspaceKey, fencingToken };
    const context = (sessionID: string) => ({
      sessionID,
      abort: new AbortController().signal,
    });
    const publish = createSessionLockPublishTool(ports, scope);
    const list = createSessionLockListTool(ports, scope);
    const renew = createSessionLockRenewTool(ports, scope);
    const release = createSessionLockReleaseTool(ports, scope);

    const published = JSON.parse(
      await publish.execute(
        {
          ttl_seconds: 60,
          title: "Schema migration",
          description: "Coordinates schema work.",
          instructions: "Contact the holder before changes.",
        },
        context(holder),
      ),
    );
    expect(published).toMatchObject({
      ok: true,
      value: {
        lock: {
          held_by_session_id: holder,
          created_at: "2023-11-14T22:13:20.000Z",
          expires_at: "2023-11-14T22:14:20.000Z",
        },
        notification: { eligible: 0, admitted: 0, unknown: 0 },
      },
    });
    const lockId = published.value.lock.lock_id as string;

    expect(JSON.parse(await list.execute({ limit: 50 }, context(other)))).toMatchObject({
      ok: true,
      value: { locks: [{ lock_id: lockId }] },
    });
    expect(
      JSON.parse(await renew.execute({ lock_id: lockId, ttl_seconds: 30 }, context(other))),
    ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });
    expect(
      JSON.parse(await renew.execute({ lock_id: lockId, ttl_seconds: 30 }, context(holder))),
    ).toMatchObject({ ok: true, value: { lock: { lock_id: lockId } } });
    const released = JSON.parse(await release.execute({ lock_id: lockId }, context(holder)));
    expect(released).toMatchObject({ ok: true, value: { lock: { lock_id: lockId } } });
    expect(JSON.parse(await list.execute({ limit: 50 }, context(holder)))).toMatchObject({
      ok: true,
      value: { locks: [] },
    });
  });
});
