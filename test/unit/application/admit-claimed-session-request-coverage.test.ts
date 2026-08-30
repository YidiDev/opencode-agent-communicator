import { expect, test } from "bun:test";

import {
  admitClaimedSessionRequest,
  type ClaimedSessionRequestAdmissionPorts,
} from "../../../src/application/admit-claimed-session-request";
import type { FencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function harness() {
  const fixture = await requestFixture(token, 1_000);
  const request = {
    ...fixture.request,
    deliveryState: "submitting" as const,
    submittedAtMs: 1_001,
    updatedAtMs: 1_001,
  };
  const completed: RequestMetadata = {
    ...request,
    deliveryState: "delivery_unknown",
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  };
  const ports: ClaimedSessionRequestAdmissionPorts = {
    requests: {
      completeDelivery: async () => ({ ok: true, request: completed }),
    } as unknown as ClaimedSessionRequestAdmissionPorts["requests"],
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" }) },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => 1_001 },
  };
  return {
    ports,
    input: {
      workspaceKey: request.workspaceKey,
      fencingToken: token,
      request,
      envelope: fixture.envelopeJson,
      control: { abort: new AbortController().signal, deadlineMs: 9_000 },
      effectSignal: new AbortController().signal,
    },
  };
}

test("claimed admission contains a malformed native promise as durable ambiguity", async () => {
  const setup = await harness();
  setup.ports.nativeSteer.steerRequest = (() => ({})) as never;
  expect(await admitClaimedSessionRequest(setup.ports, setup.input)).toMatchObject({
    ok: true,
    value: { outcome: "delivery_unknown" },
  });
});

test("claimed admission contains a malformed persistence promise", async () => {
  const setup = await harness();
  setup.ports.requests.completeDelivery = (() => ({})) as never;
  expect(await admitClaimedSessionRequest(setup.ports, setup.input)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
});
