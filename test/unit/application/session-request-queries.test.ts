import { expect, test } from "bun:test";

import { getSessionRequest } from "../../../src/application/get-session-request";
import { listSessionRequests } from "../../../src/application/list-session-requests";
import { encodeRequestListCursor } from "../../../src/application/request-list-cursor";
import type {
  ParticipantRequestGet,
  ParticipantRequestPage,
  RequestParticipantQueryPort,
} from "../../../src/application/request-ports";
import { validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { requestFixture } from "../../support/request-store";

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
    readonly requests?: {
      readonly listForParticipant?: (
        input: Parameters<RequestParticipantQueryPort["listForParticipant"]>[0],
      ) => Promise<ParticipantRequestPage & { readonly terminalized?: readonly RequestMetadata[] }>;
      readonly getParticipantRequest?: (
        input: Parameters<RequestParticipantQueryPort["getParticipantRequest"]>[0],
      ) => Promise<
        (ParticipantRequestGet & { readonly terminalized?: readonly RequestMetadata[] }) | undefined
      >;
    };
  } = {},
) {
  let membershipCalls = 0;
  return {
    get membershipCalls() {
      return membershipCalls;
    },
    value: {
      readiness: { assertReady: () => undefined },
      notifications: { notifyTerminal: () => undefined },
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
        listForParticipant: async (
          input: Parameters<RequestParticipantQueryPort["listForParticipant"]>[0],
        ) => {
          const page = await (
            options.requests?.listForParticipant ?? (async () => ({ items: [], hasMore: false }))
          )(input);
          return {
            ...page,
            terminalized: "terminalized" in page ? page.terminalized : [],
          };
        },
        getParticipantRequest: async (
          input: Parameters<RequestParticipantQueryPort["getParticipantRequest"]>[0],
        ) => {
          const found = await (options.requests?.getParticipantRequest ?? (async () => undefined))(
            input,
          );
          return found ? { ...found, terminalized: found.terminalized ?? [] } : undefined;
        },
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

test("strictly snapshots list and get arguments before any membership effect", async () => {
  const mock = ports();
  const getter = Object.defineProperty({}, "request_id", {
    enumerable: true,
    get: () => {
      throw new Error("must not run");
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error("hostile proxy");
      },
    },
  );
  for (const query of [
    null,
    { role: null },
    { limit: null },
    { cursor: null },
    { extra: true },
    proxy,
  ]) {
    expect(await listSessionRequests(mock.value, context, query)).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  }
  for (const args of [null, {}, { request_id: requestId.value, extra: true }, getter, proxy]) {
    expect(await getSessionRequest(mock.value, context, args)).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  }
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

test("list/get notify committed query-induced terminalizations without leaking them", async () => {
  const prepared = await requestFixture(token, 1, "ses_caller", "ses_target", workspace.value);
  const { payloadSha256: _payloadSha256, ...base } = prepared.request;
  const terminal = {
    ...base,
    resolutionState: "cancelled" as const,
    updatedAtMs: 2,
    resolvedAtMs: 2,
  };
  const notified: unknown[] = [];
  const notifications = { notifyTerminal: (event: unknown) => void notified.push(event) };
  const listed = ports({
    requests: {
      listForParticipant: async () => ({ items: [], hasMore: false, terminalized: [terminal] }),
    },
  });
  expect(await listSessionRequests({ ...listed.value, notifications }, context)).toEqual({
    ok: true,
    value: { items: [] },
  });

  const got = ports({
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
        terminalized: [terminal],
      }),
    },
  });
  const result = await getSessionRequest({ ...got.value, notifications }, context, {
    request_id: requestId.value,
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect("terminalized" in result.value).toBe(false);
  expect(notified).toHaveLength(2);
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

test("rejects available-result content paired with expired metadata", async () => {
  const incoherent = ports({
    requests: {
      getParticipantRequest: async () => ({
        outcome: "available_result",
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
        result: { kind: "ask", answers: [[]] },
      }),
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
  const metadata = {
    ...metadataBase,
    participantRole: "source" as const,
    kind: "wait" as const,
    resolutionState: "pending" as const,
    resultState: "none" as const,
    createdAtMs: 42,
    updatedAtMs: 42,
    deadlineAtMs: 43,
  };
  let receivedBoundary: unknown;
  const first = ports({
    requests: {
      listForParticipant: async (input) => {
        receivedBoundary = input.boundary;
        return { items: [metadata], hasMore: true };
      },
    },
  });
  const listed = await listSessionRequests(first.value, context, { role: "outbox", limit: 100 });
  expect(listed).toMatchObject({ ok: true, value: { items: [metadata] } });
  if (!listed.ok || !listed.value.nextCursor) throw new Error("missing cursor");
  await listSessionRequests(first.value, context, {
    role: "outbox",
    cursor: listed.value.nextCursor,
  });
  expect(receivedBoundary).toEqual({ createdAtMs: 42, requestId: requestId.value });
  expect(listed.value.nextCursor).toBe(
    encodeRequestListCursor("outbox", { createdAtMs: 42, requestId: requestId.value }),
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
