import { describe, expect, test } from "bun:test";

import type { SessionSendPorts } from "../../../src/application/send-session-message";
import { sendSessionMessage as sendApplicationSessionMessage } from "../../../src/application/send-session-message";
import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const sendSessionMessage = (
  ...input: Parameters<typeof sendApplicationSessionMessage>
): ReturnType<typeof sendApplicationSessionMessage> => {
  const [ports, context, args] = input;
  return sendApplicationSessionMessage(ports, context, { ...args, delivery: "user" });
};

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:send-boundaries"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const deliveryId = value(validateDeliveryId(`dlv_${"6".repeat(32)}`));
const messageId = value(validateNativeMessageId(`msg_${"7".repeat(32)}`));
const token = value(validateFencingToken(17));

function prepared(): DeliveryMetadata {
  return {
    id: deliveryId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId: messageId,
    state: "prepared",
    contentByteLength: 4,
    contentSha256: "c".repeat(64) as Sha256Digest,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function submitting(): DeliveryMetadata {
  return { ...prepared(), state: "submitting", submittedAtMs: 2, updatedAtMs: 2 };
}

function cancelled(): DeliveryMetadata {
  return { ...prepared(), state: "cancelled", cancelledAtMs: 2, updatedAtMs: 2 };
}

function fixture() {
  let membershipReads = 0;
  const ports: SessionSendPorts = {
    readiness: { fencingToken: token, assertReady() {} },
    membership: {
      async readCurrentRoots() {
        membershipReads += 1;
        return { sourceTitle: undefined, sourceVisible: true, targetVisible: true };
      },
    },
    authorization: { authorizeMessage: async () => ({ kind: "allow" }) },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    clock: { nowMs: () => 2 },
    ids: {
      deliveryId: () => deliveryId,
      nativeMessageId: () => messageId,
    } as never,
    digest: { sha256: async () => new Uint8Array(32).fill(0xcc) },
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" }) },
    deliveries: {
      createPrepared: async () => ({ ok: true, delivery: prepared() }),
      cancelPrepared: async () => ({ ok: true, delivery: cancelled() }),
      claimPrepared: async () => ({ ok: true, delivery: submitting(), envelope: "{}" }),
      completeSubmission: async () => ({
        ok: true,
        delivery: {
          ...submitting(),
          state: "admission_unknown",
          admissionUnknownAtMs: 3,
          updatedAtMs: 3,
        },
      }),
    } as never,
  };
  return { ports, membershipReads: () => membershipReads };
}

const context = (abort = new AbortController().signal) => ({
  workspaceKey,
  sourceSessionId,
  abort,
});
const args = { session_id: targetSessionId, content: "work" };

describe("session send strict adapter boundaries", () => {
  test.each([
    { kind: "unknown" },
    { kind: "allow", extra: true },
    Object.defineProperty({}, "kind", { enumerable: true, get: () => "allow" }),
  ])("fails closed for malformed authorization decision %#", async (decision) => {
    const current = fixture();
    let didPrepare = false;
    current.ports.authorization.authorizeMessage = async () => decision as never;
    current.ports.deliveries.createPrepared = async () => {
      didPrepare = true;
      return { ok: true, delivery: prepared() } as never;
    };
    expect(await sendSessionMessage(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    expect(didPrepare).toBeFalse();
  });

  test("rejects malformed content and initial membership failures before persistence", async () => {
    const invalid = fixture();
    expect(
      await sendSessionMessage(invalid.ports, context(), {
        session_id: targetSessionId,
        content: 7,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });

    const unavailable = fixture();
    unavailable.ports.membership.readCurrentRoots = async () => {
      throw new Error("membership unavailable");
    };
    expect(await sendSessionMessage(unavailable.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
  });

  test("does not persist when membership fails after authorization", async () => {
    const current = fixture();
    let reads = 0;
    current.ports.membership.readCurrentRoots = async () => {
      reads += 1;
      if (reads === 2) throw new Error("membership changed");
      return { sourceTitle: undefined, sourceVisible: true, targetVisible: true };
    };
    expect(await sendSessionMessage(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
  });

  test("cancels prepared state when the final membership read fails", async () => {
    const current = fixture();
    let reads = 0;
    current.ports.membership.readCurrentRoots = async () => {
      reads += 1;
      if (reads === 3) throw new Error("final membership unavailable");
      return { sourceTitle: undefined, sourceVisible: true, targetVisible: true };
    };
    expect(await sendSessionMessage(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });

    const cancellationFailure = fixture();
    reads = 0;
    cancellationFailure.ports.membership.readCurrentRoots = async () => {
      reads += 1;
      if (reads === 3) throw new Error("final membership unavailable");
      return { sourceTitle: undefined, sourceVisible: true, targetVisible: true };
    };
    cancellationFailure.ports.deliveries.cancelPrepared = async () => ({
      ok: false,
      code: "storage_unavailable",
    });
    expect(await sendSessionMessage(cancellationFailure.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  });

  test("rejects malformed prepare and claim transitions", async () => {
    const malformedPrepare = fixture();
    malformedPrepare.ports.deliveries.createPrepared = async () => ({
      ok: true,
      delivery: { ...prepared(), contentSha256: "bad" as Sha256Digest },
    });
    expect(await sendSessionMessage(malformedPrepare.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });

    const wrongPrepareState = fixture();
    wrongPrepareState.ports.deliveries.createPrepared = async () => ({
      ok: true,
      delivery: cancelled(),
    });
    expect(await sendSessionMessage(wrongPrepareState.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });

    for (const claim of [
      async () => ({ ok: false as const, code: "rate_limited" as const }),
      async () => ({
        ok: true as const,
        delivery: { ...submitting(), contentSha256: "bad" as Sha256Digest },
        envelope: "{}",
      }),
      async () => ({ ok: true as const, delivery: prepared(), envelope: "{}" }),
    ]) {
      const current = fixture();
      current.ports.deliveries.claimPrepared = claim as never;
      expect(await sendSessionMessage(current.ports, context(), args)).toMatchObject({ ok: false });
    }
  });

  test("returns cancellation failure rather than hiding ownership loss cleanup failure", async () => {
    const current = fixture();
    let ownershipChecks = 0;
    current.ports.ownership.isCurrent = async () => {
      ownershipChecks += 1;
      return ownershipChecks === 1;
    };
    current.ports.deliveries.cancelPrepared = async () => ({
      ok: false,
      code: "storage_unavailable",
    });
    expect(await sendSessionMessage(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  });

  test("records and reports admission_unknown when native submission never settles", async () => {
    const current = fixture();
    let recordedState: string | undefined;
    current.ports.nativeQueue.queueMessage = async () => new Promise(() => undefined);
    const complete = current.ports.deliveries.completeSubmission;
    current.ports.deliveries.completeSubmission = async (input) => {
      recordedState = input.state;
      return complete(input);
    };

    const result = await sendSessionMessage(
      current.ports,
      { ...context(), deadlineMs: Date.now() + 20 },
      args,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
    });
    expect(recordedState).toBe("admission_unknown");
  });
});
