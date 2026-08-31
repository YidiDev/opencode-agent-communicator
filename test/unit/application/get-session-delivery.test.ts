import { describe, expect, test } from "bun:test";
import type {
  CurrentRootMembership,
  DeliveryPersistencePort,
} from "../../../src/application/delivery-ports";
import { getSessionDelivery } from "../../../src/application/get-session-delivery";
import type { ContextAdmissionMetadata } from "../../../src/domain/context-admissions";
import type { DeliveryMetadata, DeliveryParticipantRole } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:one"));
const otherWorkspaceKey = valid(validateWorkspaceKey("workspace:two"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const strangerSessionId = valid(validateSessionId("ses_stranger"));
const deliveryId = valid(validateDeliveryId(`dlv_${"a".repeat(32)}`));

const metadata: DeliveryMetadata = {
  id: deliveryId,
  workspaceKey,
  sourceSessionId,
  targetSessionId,
  nativeMessageId: valid(validateNativeMessageId(`msg_${"b".repeat(32)}`)),
  state: "admitted",
  contentByteLength: 6,
  contentSha256: "c".repeat(64) as Sha256Digest,
  createdAtMs: 1,
  updatedAtMs: 2,
  submittedAtMs: 2,
  admittedAtMs: 2,
  admissionEvidence: {
    nativeMessageId: valid(validateNativeMessageId(`msg_${"b".repeat(32)}`)),
    state: "admitted",
    admittedSeq: 1,
    observedAtMs: 2,
  },
};

const contextMetadata: ContextAdmissionMetadata = {
  id: deliveryId,
  kind: "message",
  workspaceKey,
  sourceSessionId,
  targetSessionId,
  state: "awaiting_context",
  contentByteLength: 6,
  contentSha256: "d".repeat(64),
  createdAtMs: 1,
  updatedAtMs: 2,
  awaitingContextAtMs: 2,
};

interface LookupFixture {
  readonly deliveries: DeliveryPersistencePort;
  readonly queries: Array<{
    workspaceKey: string;
    deliveryId: string;
    participantSessionId: string;
  }>;
  readonly contextQueries: Array<{
    workspaceKey: string;
    deliveryId: string;
    participantSessionId: string;
  }>;
  membership: CurrentRootMembership;
  throwStorage: boolean;
  throwOwnership: boolean;
  contextAdmission: ContextAdmissionMetadata | undefined;
}

function lookupFixture(): LookupFixture {
  const queries: LookupFixture["queries"] = [];
  const contextQueries: LookupFixture["contextQueries"] = [];
  const result: LookupFixture = {
    queries,
    contextQueries,
    membership: { sourceVisible: true, targetVisible: false, sourceTitle: "caller" },
    throwStorage: false,
    throwOwnership: false,
    contextAdmission: undefined,
    deliveries: {
      async createPrepared() {
        throw new Error("not used");
      },
      async cancelPrepared() {
        throw new Error("not used");
      },
      async claimPrepared() {
        throw new Error("not used");
      },
      async completeSubmission() {
        throw new Error("not used");
      },
      async listRecoverable() {
        return [];
      },
      async getForParticipant(query) {
        queries.push(query);
        if (result.throwOwnership) throw new OwnershipLostFault("private ownership detail");
        if (result.throwStorage) throw new Error("private storage detail");
        if (query.workspaceKey !== workspaceKey) return undefined;
        let role: DeliveryParticipantRole | undefined;
        if (query.participantSessionId === sourceSessionId) role = "source";
        if (query.participantSessionId === targetSessionId) role = "target";
        return role ? { role, delivery: metadata } : undefined;
      },
    },
  };
  return result;
}

function ports(fake: LookupFixture) {
  return {
    readiness: { assertReady: () => undefined },
    deliveries: fake.deliveries,
    contexts: {
      async getContextAdmissionForParticipant(query: LookupFixture["contextQueries"][number]) {
        fake.contextQueries.push(query);
        if (fake.throwOwnership) throw new OwnershipLostFault("private ownership detail");
        if (fake.throwStorage) throw new Error("private storage detail");
        if (!fake.contextAdmission || query.workspaceKey !== workspaceKey) return undefined;
        if (query.participantSessionId === sourceSessionId) {
          return { role: "source" as const, admission: fake.contextAdmission };
        }
        if (query.participantSessionId === targetSessionId) {
          return { role: "target" as const, admission: fake.contextAdmission };
        }
        return undefined;
      },
    },
    membership: {
      async readCurrentRoots() {
        return fake.membership;
      },
    },
  };
}

describe("session_delivery_get authorization", () => {
  test.each([
    [sourceSessionId, "source"],
    [targetSessionId, "target"],
  ] as const)("allows the stored %s participant role", async (caller, role) => {
    const fake = lookupFixture();
    const result = await getSessionDelivery(
      ports(fake),
      { workspaceKey, sourceSessionId: caller },
      { delivery_id: deliveryId },
    );
    expect(result).toMatchObject({ ok: true, value: { role, delivery: { state: "admitted" } } });
    expect(JSON.stringify(result)).not.toContain('content":');
  });

  test.each([
    [sourceSessionId, "source"],
    [targetSessionId, "target"],
  ] as const)(
    "recovers context admission for the stored %s participant role",
    async (caller, role) => {
      const fake = lookupFixture();
      fake.deliveries.getForParticipant = async () => undefined;
      fake.contextAdmission = contextMetadata;
      const result = await getSessionDelivery(
        ports(fake),
        { workspaceKey, sourceSessionId: caller },
        { delivery_id: deliveryId },
      );
      expect(result).toMatchObject({
        ok: true,
        value: { role, transport: "context", delivery: { state: "awaiting_context" } },
      });
    },
  );

  test("does not require the counterpart to remain visible", async () => {
    const fake = lookupFixture();
    fake.membership = { sourceVisible: true, targetVisible: false, sourceTitle: "source" };
    expect(
      await getSessionDelivery(
        ports(fake),
        { workspaceKey, sourceSessionId },
        { delivery_id: deliveryId },
      ),
    ).toMatchObject({ ok: true });
  });

  test("binds lookup to workspace and participant in one store query", async () => {
    const fake = lookupFixture();
    const result = await getSessionDelivery(
      ports(fake),
      { workspaceKey: otherWorkspaceKey, sourceSessionId },
      { delivery_id: deliveryId },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "not_found_or_unauthorized" },
    });
    expect(fake.queries).toEqual([
      {
        workspaceKey: otherWorkspaceKey,
        deliveryId,
        participantSessionId: sourceSessionId,
      },
    ]);
  });

  test("missing and unauthorized IDs have an identical constant-shape response", async () => {
    const unauthorized = lookupFixture();
    unauthorized.contextAdmission = contextMetadata;
    const missing = lookupFixture();
    missing.deliveries.getForParticipant = async () => undefined;
    const first = await getSessionDelivery(
      ports(unauthorized),
      { workspaceKey, sourceSessionId: strangerSessionId },
      { delivery_id: deliveryId },
    );
    const second = await getSessionDelivery(
      ports(missing),
      { workspaceKey, sourceSessionId: strangerSessionId },
      { delivery_id: deliveryId },
    );
    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: false,
      error: {
        code: "not_found_or_unauthorized",
        message: "Delivery was not found or the caller is not authorized.",
        retryable: false,
      },
    });
  });

  test("rejects malformed IDs before membership or store I/O", async () => {
    const fake = lookupFixture();
    let membershipCalls = 0;
    const result = await getSessionDelivery(
      {
        readiness: { assertReady: () => undefined },
        deliveries: fake.deliveries,
        contexts: ports(fake).contexts,
        membership: {
          async readCurrentRoots() {
            membershipCalls += 1;
            return fake.membership;
          },
        },
      },
      { workspaceKey, sourceSessionId },
      { delivery_id: "dlv_not-canonical" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(membershipCalls).toBe(0);
    expect(fake.queries).toEqual([]);
  });
});

describe("session_delivery_get boundary failures", () => {
  test("maps invocation expiry at each external boundary", async () => {
    const beforeMembership = lookupFixture();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(
      await getSessionDelivery(
        ports(beforeMembership),
        {
          workspaceKey,
          sourceSessionId,
          abort: alreadyAborted.signal,
          deadlineMs: Date.now() + 1_000,
        },
        { delivery_id: deliveryId },
      ),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });

    const beforeDelivery = lookupFixture();
    const deliveryAbort = new AbortController();
    const deliveryPorts = ports(beforeDelivery);
    deliveryPorts.membership.readCurrentRoots = async () => {
      deliveryAbort.abort();
      return beforeDelivery.membership;
    };
    expect(
      await getSessionDelivery(
        deliveryPorts,
        {
          workspaceKey,
          sourceSessionId,
          abort: deliveryAbort.signal,
          deadlineMs: Date.now() + 1_000,
        },
        { delivery_id: deliveryId },
      ),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });

    const beforeContext = lookupFixture();
    const contextAbort = new AbortController();
    beforeContext.deliveries.getForParticipant = async () => {
      contextAbort.abort();
      return undefined;
    };
    expect(
      await getSessionDelivery(
        ports(beforeContext),
        {
          workspaceKey,
          sourceSessionId,
          abort: contextAbort.signal,
          deadlineMs: Date.now() + 1_000,
        },
        { delivery_id: deliveryId },
      ),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
  });

  test("hides malformed persisted delivery metadata", async () => {
    const fake = lookupFixture();
    fake.deliveries.getForParticipant = async () => ({
      role: "source",
      delivery: { ...metadata, state: "future_state" } as never,
    });
    expect(
      await getSessionDelivery(
        ports(fake),
        { workspaceKey, sourceSessionId },
        { delivery_id: deliveryId },
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });
    expect(fake.contextQueries).toEqual([]);
  });

  test.each([
    [new OwnershipLostFault("private context ownership detail"), "ownership_lost"],
    [new Error("private context storage detail"), "storage_unavailable"],
  ] as const)("maps context lookup rejection to %s", async (cause, code) => {
    const fake = lookupFixture();
    fake.deliveries.getForParticipant = async () => undefined;
    const lookup = ports(fake);
    lookup.contexts.getContextAdmissionForParticipant = async () => {
      throw cause;
    };
    const result = await getSessionDelivery(
      lookup,
      { workspaceKey, sourceSessionId },
      { delivery_id: deliveryId },
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain(cause.message);
  });

  test("requires the caller itself to remain a current visible root", async () => {
    const fake = lookupFixture();
    fake.membership = { sourceVisible: false, targetVisible: false, sourceTitle: undefined };
    const result = await getSessionDelivery(
      ports(fake),
      { workspaceKey, sourceSessionId },
      { delivery_id: deliveryId },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "caller_not_visible" } });
    expect(fake.queries).toEqual([]);
  });

  test("maps storage faults without leaking details", async () => {
    const fake = lookupFixture();
    fake.throwStorage = true;
    const result = await getSessionDelivery(
      ports(fake),
      { workspaceKey, sourceSessionId },
      { delivery_id: deliveryId },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "storage_unavailable",
        message: "Delivery storage is unavailable.",
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private storage detail");
  });

  test("preserves real ownership fault classification without leaking details", async () => {
    const fake = lookupFixture();
    fake.throwOwnership = true;
    const result = await getSessionDelivery(
      ports(fake),
      { workspaceKey, sourceSessionId },
      { delivery_id: deliveryId },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "ownership_lost",
        message: "Coordinator ownership was lost.",
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private ownership detail");
  });

  test("preserves ownership loss from the membership boundary", async () => {
    const fake = lookupFixture();
    const result = await getSessionDelivery(
      {
        readiness: { assertReady: () => undefined },
        deliveries: fake.deliveries,
        contexts: ports(fake).contexts,
        membership: {
          async readCurrentRoots() {
            throw new OwnershipLostFault("private membership ownership detail");
          },
        },
      },
      { workspaceKey, sourceSessionId },
      { delivery_id: deliveryId },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    expect(JSON.stringify(result)).not.toContain("private membership ownership detail");
  });

  test("maps a generic membership rejection to native unavailability", async () => {
    const fake = lookupFixture();
    const result = await getSessionDelivery(
      {
        ...ports(fake),
        membership: {
          readCurrentRoots: async () => {
            throw new Error("private native detail");
          },
        },
      },
      { workspaceKey, sourceSessionId },
      { delivery_id: deliveryId },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("private native detail");
  });
});
