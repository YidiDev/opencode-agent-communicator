import { expect, test } from "bun:test";

import {
  authorizeBlockingRequest,
  currentRequestOwnership,
  observeActiveRequestParticipants,
  proveCurrentCallerVisibility,
  proveCurrentRequestVisibility,
} from "../../../src/application/blocking-request-creation-preconditions";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function fixture() {
  const request = (await requestFixture(token, 1_000)).request;
  const controller = new AbortController();
  const context: SessionBlockingRequestContext = {
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    fencingToken: token,
    abort: controller.signal,
    deadlineMs: request.deadlineAtMs,
  };
  const ports = {
    ownership: { isCurrent: async () => true },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "busy" as const,
      }),
    },
    membership: {
      readCurrentRoots: async () => ({ sourceVisible: true, targetVisible: true }),
    },
    authorization: { authorizeRequest: async () => ({ kind: "allow" as const }) },
    clock: { nowMs: () => 1_000 },
  } as unknown as SessionBlockingRequestPorts;
  return { context, controller, ports, request };
}

test("blocking ownership fails closed for false, ordinary rejection, and post-read cancellation", async () => {
  const notOwner = await fixture();
  notOwner.ports.ownership.isCurrent = async () => false;
  expect(await currentRequestOwnership(notOwner.ports, notOwner.context)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });

  const rejected = await fixture();
  rejected.ports.ownership.isCurrent = async () => {
    throw new Error("store unavailable");
  };
  expect(await currentRequestOwnership(rejected.ports, rejected.context)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });

  const cancelled = await fixture();
  cancelled.ports.ownership.isCurrent = async () => {
    cancelled.controller.abort("cancelled");
    return true;
  };
  expect(await currentRequestOwnership(cancelled.ports, cancelled.context)).toMatchObject({
    ok: false,
    error: { code: "request_cancelled" },
  });
});

test("participant observations preserve visibility and activity failure classifications", async () => {
  const active = await fixture();
  expect(
    await observeActiveRequestParticipants(
      active.ports,
      active.context,
      active.request.targetSessionId,
    ),
  ).toEqual({ ok: true, value: true });

  const cases = [
    [{ sourceVisible: false, targetVisible: true, targetStatus: "busy" }, "caller_not_visible"],
    [{ sourceVisible: true, targetVisible: false, targetStatus: "busy" }, "target_not_visible"],
    [{ sourceVisible: true, targetVisible: true, targetStatus: "idle" }, "target_idle"],
    [
      { sourceVisible: true, targetVisible: true, targetStatus: "unknown" },
      "target_status_unknown",
    ],
    [null, "native_unavailable"],
  ] as const;
  for (const [observation, code] of cases) {
    const value = await fixture();
    value.ports.activity.observeRequestParticipants = async () => observation as never;
    expect(
      await observeActiveRequestParticipants(
        value.ports,
        value.context,
        value.request.targetSessionId,
      ),
    ).toMatchObject({ ok: false, error: { code } });
  }

  for (const [cause, code] of [
    [new OwnershipLostFault(), "ownership_lost"],
    [new Error("native unavailable"), "native_unavailable"],
  ] as const) {
    const value = await fixture();
    value.ports.activity.observeRequestParticipants = async () => {
      throw cause;
    };
    expect(
      await observeActiveRequestParticipants(
        value.ports,
        value.context,
        value.request.targetSessionId,
      ),
    ).toMatchObject({ ok: false, error: { code } });
  }
});

test("membership proofs reject malformed, hidden, interrupted, and unavailable observations", async () => {
  for (const [raw, callerCode, requestCode] of [
    [{ sourceVisible: false, targetVisible: true }, "caller_not_visible", "caller_not_visible"],
    [{ sourceVisible: true, targetVisible: false }, undefined, "target_not_visible"],
    [{ sourceVisible: true }, undefined, "native_unavailable"],
    [null, "native_unavailable", "native_unavailable"],
  ] as const) {
    const value = await fixture();
    value.ports.membership.readCurrentRoots = async () => raw as never;
    if (callerCode) {
      expect(await proveCurrentCallerVisibility(value.ports, value.context)).toMatchObject({
        ok: false,
        error: { code: callerCode },
      });
    }
    expect(
      await proveCurrentRequestVisibility(
        value.ports,
        value.context,
        value.request.targetSessionId,
      ),
    ).toMatchObject({
      ok: requestCode === undefined,
      ...(requestCode ? { error: { code: requestCode } } : {}),
    });
  }

  for (const prove of ["caller", "request"] as const) {
    for (const [cause, code] of [
      [new OwnershipLostFault(), "ownership_lost"],
      [new Error("native unavailable"), "native_unavailable"],
    ] as const) {
      const value = await fixture();
      value.ports.membership.readCurrentRoots = async () => {
        throw cause;
      };
      const result =
        prove === "caller"
          ? await proveCurrentCallerVisibility(value.ports, value.context)
          : await proveCurrentRequestVisibility(
              value.ports,
              value.context,
              value.request.targetSessionId,
            );
      expect(result).toMatchObject({ ok: false, error: { code } });
    }
  }
});

test("blocking authorization keeps static decisions and cancellation fail closed", async () => {
  for (const [decision, code] of [
    [{ kind: "deny" }, "permission_denied"],
    [{ kind: "approval_rejected" }, "approval_rejected"],
  ] as const) {
    const value = await fixture();
    value.ports.authorization.authorizeRequest = async () => decision;
    expect(
      await authorizeBlockingRequest(value.ports, value.context, value.request, 30),
    ).toMatchObject({ ok: false, error: { code } });
  }

  const rejected = await fixture();
  rejected.ports.authorization.authorizeRequest = async () => {
    throw new Error("authorization store unavailable");
  };
  expect(
    await authorizeBlockingRequest(rejected.ports, rejected.context, rejected.request, 30),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  const cancelled = await fixture();
  cancelled.ports.authorization.authorizeRequest = () => {
    cancelled.controller.abort("cancelled");
    return new Promise<never>(() => undefined);
  };
  expect(
    await authorizeBlockingRequest(cancelled.ports, cancelled.context, cancelled.request, 30),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
});
