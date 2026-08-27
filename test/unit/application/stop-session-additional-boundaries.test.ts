import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { type SessionStopPorts, stopSession } from "../../../src/application/stop-session";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { requestFixture } from "../../support/request-store";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:stop-additional"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const token = value(validateFencingToken(29));

function fixture(): SessionStopPorts {
  return {
    readiness: { fencingToken: token, assertReady() {} },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "busy",
      }),
    },
    approval: { requestStopApproval: async () => "approved" },
    requests: { stopPendingRequests: async () => ({ ok: true, terminalized: [] }) },
    nativeInterrupt: { interruptSession: async () => "interrupted" },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    notifications: { notifyTerminal() {} },
    digest: {
      async sha256(bytes) {
        return new Uint8Array(createHash("sha256").update(bytes).digest());
      },
    },
  };
}

const context = (abort = new AbortController().signal, deadlineMs?: number) => ({
  workspaceKey,
  sourceSessionId,
  abort,
  ...(deadlineMs === undefined ? {} : { deadlineMs }),
});

async function execute(ports: SessionStopPorts) {
  return stopSession(ports, context(), { session_id: targetSessionId, reason: "done" });
}

describe("session stop final-effect boundaries", () => {
  test("validates target and reason before approval", async () => {
    expect(
      await stopSession(fixture(), context(), { session_id: "bad", reason: "done" }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(
      await stopSession(fixture(), context(), { session_id: targetSessionId, reason: 7 }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  test("preserves committed state when final observation is unavailable or unknown", async () => {
    for (const final of [
      async () => {
        throw new Error("native unavailable");
      },
      async () => ({ sourceVisible: true, targetVisible: true, targetStatus: "unknown" as const }),
      async () => ({ sourceVisible: false, targetVisible: true, targetStatus: "busy" as const }),
    ]) {
      const ports = fixture();
      let reads = 0;
      ports.activity.observeRequestParticipants = async () => {
        reads += 1;
        if (reads === 3) return final() as never;
        return { sourceVisible: true, targetVisible: true, targetStatus: "busy" };
      };
      expect(await execute(ports)).toMatchObject({
        ok: false,
        error: { code: "native_outcome_unknown" },
      });
    }
  });

  test("does not interrupt when ownership is lost after the durable stop", async () => {
    const ports = fixture();
    let checks = 0;
    ports.ownership.isCurrent = async () => {
      checks += 1;
      return checks === 1;
    };
    expect(await execute(ports)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
  });

  test("treats malformed native success and final ownership loss as unknown", async () => {
    const malformed = fixture();
    malformed.nativeInterrupt.interruptSession = async () => "unknown";
    expect(await execute(malformed)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });

    const lostAfterInterrupt = fixture();
    let checks = 0;
    lostAfterInterrupt.ownership.isCurrent = async () => {
      checks += 1;
      return checks < 3;
    };
    expect(await execute(lostAfterInterrupt)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
  });

  test("revalidates visibility immediately before the durable stop", async () => {
    for (const observation of [
      () => {
        throw new Error("native read");
      },
      () => ({ sourceVisible: true, targetVisible: false, targetStatus: "busy" as const }),
    ]) {
      const ports = fixture();
      let reads = 0;
      ports.activity.observeRequestParticipants = async () => {
        reads += 1;
        if (reads === 2) return observation() as never;
        return { sourceVisible: true, targetVisible: true, targetStatus: "busy" };
      };
      expect(await execute(ports)).toMatchObject({ ok: false });
    }
  });

  test("contains a deadline that expires immediately after a resolved external call", async () => {
    let nowReads = 0;
    const originalNow = Date.now;
    Date.now = () => {
      nowReads += 1;
      return nowReads < 4 ? 10 : 20;
    };
    try {
      expect(
        await stopSession(fixture(), context(new AbortController().signal, 15), {
          session_id: targetSessionId,
        }),
      ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    } finally {
      Date.now = originalNow;
    }
  });

  test("counts and notifies committed target/source stop transitions", async () => {
    const target = await requestFixture(token, 1, "ses_source", "ses_target", workspaceKey);
    const source = await requestFixture(token, 2, "ses_target", "ses_other", workspaceKey);
    const withoutPayloadDigest = (
      request: typeof target.request,
      resolutionState: "target_stopped" | "source_stopped",
      resolvedAtMs: number,
    ): RequestMetadata => {
      const { payloadSha256: _, ...identity } = request;
      return { ...identity, resolutionState, resolvedAtMs, updatedAtMs: resolvedAtMs };
    };
    const terminalized = [
      withoutPayloadDigest(target.request, "target_stopped", 3),
      withoutPayloadDigest(source.request, "source_stopped", 4),
    ];
    const ports = fixture();
    const notifications: unknown[] = [];
    ports.requests.stopPendingRequests = async () => ({ ok: true, terminalized });
    ports.notifications.notifyTerminal = (event) => {
      notifications.push(event);
    };
    expect(await execute(ports)).toMatchObject({
      ok: true,
      value: {
        communicatorState: { requestsTerminalized: 2, targetStopped: 1, sourceStopped: 1 },
      },
    });
    expect(notifications).toHaveLength(2);
  });
});
