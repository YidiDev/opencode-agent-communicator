import { expect, test } from "bun:test";

import { getSessionRequest } from "../../../src/application/get-session-request";
import { listSessionRequests } from "../../../src/application/list-session-requests";
import { encodeRequestListCursor } from "../../../src/application/request-list-cursor";
import type { RequestParticipantQueryPort } from "../../../src/application/request-ports";
import { validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("queries");
const caller = validateSessionId("ses_caller");
if (!workspace.ok || !caller.ok) throw new Error("bad fixture");
const token = 1 as FencingToken;
const context = {
  workspaceKey: workspace.value,
  callerSessionId: caller.value,
  fencingToken: token,
};
const requestId = validateRequestId(`req_${"a".repeat(32)}`);
if (!requestId.ok) throw new Error("bad request fixture");
const target = validateSessionId("ses_target");
if (!target.ok) throw new Error("bad target fixture");
const metadataBase = {
  requestId: requestId.value,
  sourceSessionId: caller.value,
  targetSessionId: target.value,
  deliveryState: "prepared" as const,
  createdAtMs: 1,
  updatedAtMs: 1,
  deadlineAtMs: 2,
};

function ports(
  options: {
    readonly visible?: boolean;
    readonly membershipFault?: unknown;
    readonly requests?: Partial<RequestParticipantQueryPort>;
  } = {},
) {
  let membershipCalls = 0;
  return {
    get membershipCalls() {
      return membershipCalls;
    },
    value: {
      readiness: { assertReady: () => undefined },
      membership: {
        readCurrentRoots: async () => {
          membershipCalls++;
          if (options.membershipFault) throw options.membershipFault;
          return {
            sourceTitle: undefined,
            sourceVisible: options.visible ?? true,
            targetVisible: false,
          };
        },
      },
      requests: {
        listForParticipant:
          options.requests?.listForParticipant ?? (async () => ({ items: [], hasMore: false })),
        getParticipantRequest: options.requests?.getParticipantRequest ?? (async () => undefined),
      },
    },
  };
}

test.each([false])(
  "rejects archived, deleted, and unknown callers through invisible membership",
  async (visible) => {
    const mock = ports({ visible });
    expect((await listSessionRequests(mock.value, context)).ok).toBe(false);
    expect(
      await getSessionRequest(mock.value, context, { request_id: `req_${"a".repeat(32)}` }),
    ).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible" },
    });
  },
);

test("checks only caller visibility and does not require counterpart visibility", async () => {
  let queried = false;
  const mock = ports({
    requests: {
      listForParticipant: async () => {
        queried = true;
        return { items: [], hasMore: false };
      },
    },
  });
  expect(await listSessionRequests(mock.value, context)).toEqual({
    ok: true,
    value: { items: [] },
  });
  expect(queried).toBe(true);
});

test("maps membership faults safely while preserving ownership loss", async () => {
  const unavailable = ports({ membershipFault: new Error("private") });
  expect(await listSessionRequests(unavailable.value, context)).toMatchObject({
    ok: false,
    error: { code: "native_unavailable" },
  });
  const lost = ports({ membershipFault: new OwnershipLostFault("stale") });
  expect(await listSessionRequests(lost.value, context)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
  expect(
    await getSessionRequest(lost.value, context, { request_id: requestId.value }),
  ).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
});

test("validates caller, role, limit, cursor, and request ID before membership", async () => {
  const mock = ports();
  expect((await listSessionRequests(mock.value, { ...context, callerSessionId: "bad" })).ok).toBe(
    false,
  );
  expect((await listSessionRequests(mock.value, context, { role: "other" })).ok).toBe(false);
  expect((await listSessionRequests(mock.value, context, { limit: 101 })).ok).toBe(false);
  expect((await listSessionRequests(mock.value, context, { cursor: "bad" })).ok).toBe(false);
  expect((await getSessionRequest(mock.value, context, { request_id: "bad" })).ok).toBe(false);
  expect(mock.membershipCalls).toBe(0);
});

test("returns exact constant hidden shape and typed result expiry", async () => {
  const missing = ports();
  const hidden = await getSessionRequest(missing.value, context, {
    request_id: `req_${"a".repeat(32)}`,
  });
  expect(hidden).toEqual({
    ok: false,
    error: {
      code: "not_found_or_unauthorized",
      message: "Request was not found or the caller is not authorized.",
      retryable: false,
    },
  });
  const expired = ports({
    requests: {
      getParticipantRequest: async () => ({
        outcome: "result_expired",
        metadata: {
          ...metadataBase,
          participantRole: "source",
          kind: "ask",
          resolutionState: "answered",
          resultState: "expired",
          resolvedAtMs: 1,
          resultAvailableAtMs: 1,
          resultExpiresAtMs: 2,
          resultExpiredAtMs: 2,
        } as never,
      }),
    },
  });
  expect(
    await getSessionRequest(expired.value, context, { request_id: `req_${"a".repeat(32)}` }),
  ).toMatchObject({
    ok: false,
    error: { code: "result_expired" },
  });
});

test("returns successful exact gets and safely maps request storage faults", async () => {
  const success = ports({
    requests: {
      getParticipantRequest: async () => ({
        outcome: "metadata",
        view: "source_pending",
        metadata: {
          ...metadataBase,
          participantRole: "source",
          kind: "wait",
          resolutionState: "pending",
          resultState: "none",
        } as never,
      }),
    },
  });
  expect(
    await getSessionRequest(success.value, context, { request_id: requestId.value }),
  ).toMatchObject({
    ok: true,
    value: { outcome: "metadata" },
  });
  for (const [fault, code] of [
    [new OwnershipLostFault("stale"), "ownership_lost"],
    [new Error("sql"), "storage_unavailable"],
  ] as const) {
    const failed = ports({
      requests: {
        getParticipantRequest: async () => {
          throw fault;
        },
      },
    });
    expect(
      await getSessionRequest(failed.value, context, { request_id: requestId.value }),
    ).toMatchObject({
      ok: false,
      error: { code },
    });
  }
});

test("rejects an incoherent broad exact-get projection instead of forwarding it", async () => {
  const incoherent = ports({
    requests: {
      getParticipantRequest: async () =>
        ({
          outcome: "available_result",
          metadata: {
            ...metadataBase,
            participantRole: "source",
            kind: "ask",
            resolutionState: "answered",
            resultState: "available",
            resolvedAtMs: 1,
            resultAvailableAtMs: 1,
            resultExpiresAtMs: 2,
          },
          result: { kind: "wait" },
        }) as never,
    },
  });
  expect(
    await getSessionRequest(incoherent.value, context, { request_id: requestId.value }),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("validates every coherent metadata and content exact-get view", async () => {
  const cases = [
    {
      callerSessionId: target.value,
      found: {
        outcome: "pending_payload",
        metadata: {
          ...metadataBase,
          participantRole: "target",
          kind: "wait",
          resolutionState: "pending",
          resultState: "none",
        },
        payload: { kind: "wait", milestone: "ready", timeoutSeconds: 1 },
      },
    },
    {
      callerSessionId: caller.value,
      found: {
        outcome: "available_result",
        metadata: {
          ...metadataBase,
          participantRole: "source",
          kind: "ask",
          resolutionState: "answered",
          resultState: "available",
          resolvedAtMs: 1,
          resultAvailableAtMs: 1,
          resultExpiresAtMs: 2,
        },
        result: { kind: "ask", answers: [[]] },
      },
    },
    {
      callerSessionId: target.value,
      found: {
        outcome: "metadata",
        view: "target_terminal",
        metadata: {
          ...metadataBase,
          participantRole: "target",
          kind: "wait",
          resolutionState: "cancelled",
          resultState: "none",
          resolvedAtMs: 1,
        },
      },
    },
    {
      callerSessionId: caller.value,
      found: {
        outcome: "metadata",
        view: "source_unsuccessful_terminal",
        metadata: {
          ...metadataBase,
          participantRole: "source",
          kind: "wait",
          resolutionState: "cancelled",
          resultState: "none",
          resolvedAtMs: 1,
        },
      },
    },
  ] as const;
  for (const item of cases) {
    const mock = ports({
      requests: { getParticipantRequest: async () => item.found as never },
    });
    expect(
      await getSessionRequest(
        mock.value,
        { ...context, callerSessionId: item.callerSessionId },
        { request_id: requestId.value },
      ),
    ).toMatchObject({ ok: true });
  }
});

test("emits and consumes a next cursor and maps list storage faults", async () => {
  const metadata = { requestId: requestId.value, createdAtMs: 42 } as never;
  let receivedBoundary: unknown;
  const first = ports({
    requests: {
      listForParticipant: async (input) => {
        receivedBoundary = input.boundary;
        return { items: [metadata], hasMore: true };
      },
    },
  });
  const listed = await listSessionRequests(first.value, context, { role: "inbox", limit: 100 });
  expect(listed).toMatchObject({ ok: true, value: { items: [metadata] } });
  if (!listed.ok || !listed.value.nextCursor) throw new Error("missing cursor");
  await listSessionRequests(first.value, context, {
    role: "inbox",
    cursor: listed.value.nextCursor,
  });
  expect(receivedBoundary).toEqual({ createdAtMs: 42, requestId: requestId.value });
  expect(listed.value.nextCursor).toBe(
    encodeRequestListCursor("inbox", { createdAtMs: 42, requestId: requestId.value }),
  );
  for (const [fault, code] of [
    [new OwnershipLostFault("stale"), "ownership_lost"],
    [new Error("sql"), "storage_unavailable"],
  ] as const) {
    const failed = ports({
      requests: {
        listForParticipant: async () => {
          throw fault;
        },
      },
    });
    expect(await listSessionRequests(failed.value, context)).toMatchObject({
      ok: false,
      error: { code },
    });
  }
});
