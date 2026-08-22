import { describe, expect, test } from "bun:test";
import type {
  CurrentRootMembership,
  DeliveryPersistencePort,
} from "../../../src/application/delivery-ports";
import { getSessionDelivery } from "../../../src/application/get-session-delivery";
import type { DeliveryMetadata, DeliveryParticipantRole } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
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

interface LookupFixture {
  readonly deliveries: DeliveryPersistencePort;
  readonly queries: Array<{
    workspaceKey: string;
    deliveryId: string;
    participantSessionId: string;
  }>;
  membership: CurrentRootMembership;
  throwStorage: boolean;
}

function lookupFixture(): LookupFixture {
  const queries: LookupFixture["queries"] = [];
  const result: LookupFixture = {
    queries,
    membership: { sourceVisible: true, targetVisible: false, sourceTitle: "caller" },
    throwStorage: false,
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
    deliveries: fake.deliveries,
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
        deliveries: fake.deliveries,
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
});
