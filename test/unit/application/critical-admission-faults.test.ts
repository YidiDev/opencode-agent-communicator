import { expect, test } from "bun:test";
import { admitClaimedSessionRequest } from "../../../src/application/admit-claimed-session-request";
import type { MessageAdmissionPorts } from "../../../src/application/admit-message-delivery";
import { admitClaimedMessage } from "../../../src/application/admit-message-delivery";
import type { DeliveryMetadata } from "../../../src/domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { requestFixture } from "../../support/request-store";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const token = value(validateFencingToken(41));
const workspaceKey = value(validateWorkspaceKey("workspace:critical-admission"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const deliveryId = value(validateDeliveryId(`dlv_${"a".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"b".repeat(32)}`));

function submittingDelivery(): DeliveryMetadata {
  return {
    id: deliveryId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId,
    state: "submitting",
    contentByteLength: 7,
    contentSha256: "c".repeat(64) as Sha256Digest,
    createdAtMs: 1,
    submittedAtMs: 2,
    updatedAtMs: 2,
  };
}

function messagePorts(
  overrides: {
    readonly current?: () => Promise<boolean>;
    readonly queue?: () => Promise<{ readonly kind: "unknown" }>;
    readonly complete?: () => Promise<unknown>;
    readonly nowMs?: () => number;
  } = {},
): MessageAdmissionPorts {
  return {
    ownership: {
      acquire: async () => token,
      isCurrent: overrides.current ?? (async () => true),
    },
    nativeQueue: {
      queueMessage: overrides.queue ?? (async () => ({ kind: "unknown" as const })),
    },
    deliveries: {
      completeSubmission: overrides.complete ?? (async () => ({})),
    } as never,
    clock: { nowMs: overrides.nowMs ?? (() => 3) },
  };
}

async function admitMessage(ports: MessageAdmissionPorts) {
  return admitClaimedMessage(ports, {
    workspaceKey,
    fencingToken: token,
    delivery: submittingDelivery(),
    envelope: "{}",
    abort: new AbortController().signal,
  });
}

test("message admission maps ownership and persistence faults at each effect boundary", async () => {
  expect(
    await admitMessage(
      messagePorts({
        current: async () => {
          throw new Error("ownership store unavailable");
        },
      }),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  expect(
    await admitMessage(
      messagePorts({
        complete: async () => {
          throw new Error("completion unavailable");
        },
      }),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  expect(
    await admitMessage(
      messagePorts({
        queue: async () => {
          throw new OwnershipLostFault("native fencing lost");
        },
      }),
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("message admission rechecks ownership and clock after the native effect", async () => {
  let checks = 0;
  expect(
    await admitMessage(
      messagePorts({
        current: async () => {
          checks += 1;
          if (checks === 2) throw new Error("post-effect ownership read failed");
          return true;
        },
      }),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  expect(
    await admitMessage(
      messagePorts({
        nowMs: () => {
          throw new Error("clock failed");
        },
      }),
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

async function requestAdmissionFixture() {
  const fixture = await requestFixture(token, 1_000);
  const request: RequestMetadata & { readonly deliveryState: "submitting" } = {
    ...fixture.request,
    deliveryState: "submitting",
    submittedAtMs: 1_001,
    updatedAtMs: 1_001,
  };
  return { ...fixture, request };
}

function unknownRequest(request: RequestMetadata & { readonly deliveryState: "submitting" }) {
  return {
    ...request,
    deliveryState: "delivery_unknown" as const,
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  };
}

test("claimed request admission maps rejected ownership checks before and after steer", async () => {
  const fixture = await requestAdmissionFixture();
  for (const rejectAt of [1, 2]) {
    let checks = 0;
    const result = await admitClaimedSessionRequest(
      {
        requests: {
          completeDelivery: async () => ({ ok: true, request: unknownRequest(fixture.request) }),
        } as never,
        nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
        ownership: {
          acquire: async () => token,
          isCurrent: async () => {
            checks += 1;
            if (checks === rejectAt) throw new Error("ownership read unavailable");
            return true;
          },
        },
        notifications: { notifyTerminal: () => undefined },
        clock: { nowMs: () => 1 },
      },
      {
        workspaceKey: fixture.request.workspaceKey,
        fencingToken: token,
        request: fixture.request,
        envelope: fixture.envelopeJson,
        control: { abort: new AbortController().signal },
        effectSignal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("claimed request admission maps completion rejection and hostile input safely", async () => {
  const fixture = await requestAdmissionFixture();
  const result = await admitClaimedSessionRequest(
    {
      requests: {
        completeDelivery: async () => {
          throw new OwnershipLostFault("completion fenced");
        },
      } as never,
      nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
      ownership: { acquire: async () => token, isCurrent: async () => true },
      notifications: { notifyTerminal: () => undefined },
      clock: { nowMs: () => 1 },
    },
    {
      workspaceKey: fixture.request.workspaceKey,
      fencingToken: token,
      request: fixture.request,
      envelope: fixture.envelopeJson,
      control: { abort: new AbortController().signal },
      effectSignal: new AbortController().signal,
    },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("input reflection failed");
      },
    },
  );
  expect(await admitClaimedSessionRequest({} as never, hostile as never)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
});
