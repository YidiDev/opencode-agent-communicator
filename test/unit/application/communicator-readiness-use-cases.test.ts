import { expect, test } from "bun:test";

import {
  acknowledgeSessionRequest,
  type SessionRequestAckPorts,
} from "../../../src/application/acknowledge-session-request";
import {
  cancelSessionRequest,
  type SessionRequestCancelPorts,
} from "../../../src/application/cancel-session-request";
import {
  getSessionDelivery,
  type SessionDeliveryGetPorts,
} from "../../../src/application/get-session-delivery";
import {
  getSessionRequest,
  type SessionRequestGetPorts,
} from "../../../src/application/get-session-request";
import {
  listSessionRequests,
  type SessionRequestListPorts,
} from "../../../src/application/list-session-requests";
import {
  listVisibleRootSessions,
  type SessionListPorts,
} from "../../../src/application/list-visible-root-sessions";
import {
  respondToSessionRequest,
  type SessionRespondPorts,
} from "../../../src/application/respond-to-session-request";
import {
  type SessionSignalPorts,
  signalSessionRequest,
} from "../../../src/application/signal-session-request";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("readiness-use-cases");
const caller = validateSessionId("ses_caller");
if (!workspace.ok || !caller.ok) throw new Error("invalid readiness fixture");
const lifecycleFault = new Error("communicator not ready");

function blocked(effects: { count: number }) {
  const touch = async (): Promise<never> => {
    effects.count++;
    throw new Error("ordinary effect must not run");
  };
  const readiness = {
    assertReady: () => {
      throw lifecycleFault;
    },
  };
  const membership = { readCurrentRoots: touch };
  return { readiness, membership, touch };
}

test("readiness blocks list and delivery query families before validation or effects", async () => {
  const effects = { count: 0 };
  const base = blocked(effects);
  const listPorts = {
    readiness: base.readiness,
    membership: base.membership,
    sessions: { readVisibleRoots: base.touch },
  } satisfies SessionListPorts;
  const deliveryPorts = {
    readiness: base.readiness,
    membership: base.membership,
    deliveries: {
      createPrepared: base.touch,
      cancelPrepared: base.touch,
      claimPrepared: base.touch,
      completeSubmission: base.touch,
      listRecoverable: base.touch,
      getForParticipant: base.touch,
    },
    contexts: { getContextAdmissionForParticipant: base.touch },
  } satisfies SessionDeliveryGetPorts;
  await expect(
    listVisibleRootSessions(listPorts, { workspaceKey: workspace.value, sourceSessionId: null }),
  ).rejects.toBe(lifecycleFault);
  await expect(
    getSessionDelivery(
      deliveryPorts,
      { workspaceKey: workspace.value, sourceSessionId: caller.value },
      { delivery_id: null },
    ),
  ).rejects.toBe(lifecycleFault);
  expect(effects.count).toBe(0);
});

test("readiness blocks request list/get family before validation or effects", async () => {
  const effects = { count: 0 };
  const base = blocked(effects);
  const ports = {
    readiness: base.readiness,
    notifications: { notifyTerminal: () => undefined },
    membership: base.membership,
    requests: { listForParticipant: base.touch, getParticipantRequest: base.touch },
  } satisfies SessionRequestListPorts & SessionRequestGetPorts;
  const context = {
    workspaceKey: workspace.value,
    callerSessionId: null,
    fencingToken: 1 as FencingToken,
  };
  await expect(listSessionRequests(ports, context, { limit: 0 })).rejects.toBe(lifecycleFault);
  await expect(getSessionRequest(ports, context, { request_id: null })).rejects.toBe(
    lifecycleFault,
  );
  expect(effects.count).toBe(0);
});

test("readiness blocks every terminal mutation before validation, clock, or effects", async () => {
  const effects = { count: 0 };
  const base = blocked(effects);
  const ports = {
    readiness: base.readiness,
    membership: base.membership,
    clock: {
      nowMs: () => {
        effects.count++;
        return 0;
      },
    },
    digest: { sha256: base.touch },
    requests: {
      answerAsk: base.touch,
      signalWait: base.touch,
      cancelPending: base.touch,
      acknowledgeResult: base.touch,
    },
    notifications: {
      notifyTerminal: () => {
        effects.count++;
      },
    },
  } satisfies SessionRespondPorts &
    SessionSignalPorts &
    SessionRequestCancelPorts &
    SessionRequestAckPorts;
  const context = {
    workspaceKey: workspace.value,
    callerSessionId: null,
    fencingToken: 1 as FencingToken,
    abort: new AbortController().signal,
    deadlineMs: 0,
  };
  await expect(
    respondToSessionRequest(ports, context, { request_id: null, answers: null }),
  ).rejects.toBe(lifecycleFault);
  await expect(signalSessionRequest(ports, context, { request_id: null })).rejects.toBe(
    lifecycleFault,
  );
  await expect(cancelSessionRequest(ports, context, { request_id: null })).rejects.toBe(
    lifecycleFault,
  );
  await expect(acknowledgeSessionRequest(ports, context, { request_id: null })).rejects.toBe(
    lifecycleFault,
  );
  expect(effects.count).toBe(0);
});

test("request work rejects a lifecycle epoch mismatch and stops lifecycle ownership", async () => {
  const effects = { count: 0 };
  let stopped = 0;
  const touch = async (): Promise<never> => {
    effects.count += 1;
    throw new Error("request effect must not run");
  };
  const ports = {
    readiness: {
      fencingToken: 2 as FencingToken,
      assertReady() {},
      ownershipLost() {
        stopped += 1;
      },
    },
    membership: { readCurrentRoots: touch },
    notifications: { notifyTerminal: () => undefined },
    requests: { listForParticipant: touch, getParticipantRequest: touch },
  } satisfies SessionRequestListPorts;

  await expect(
    listSessionRequests(
      ports,
      {
        workspaceKey: workspace.value,
        callerSessionId: caller.value,
        fencingToken: 1 as FencingToken,
      },
      {},
    ),
  ).rejects.toBeInstanceOf(OwnershipLostFault);
  expect({ stopped, effects: effects.count }).toEqual({ stopped: 1, effects: 0 });
});
