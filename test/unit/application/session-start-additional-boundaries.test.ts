import { describe, expect, test } from "bun:test";

import type { SessionStartPorts } from "../../../src/application/session-start-application";
import type { StartStep } from "../../../src/application/session-start-ports";
import { startSession } from "../../../src/application/start-session";
import { approvePreparedStart } from "../../../src/application/start-session-approval";
import {
  runStartAdmission,
  runStartCreation,
  runStartTitle,
} from "../../../src/application/start-session-effects";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { StartOperation, ValidatedStartArguments } from "../../../src/domain/session-start";
import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:start-additional"));
const sourceSessionId = value(validateSessionId("ses_source"));
const operationId = value(validateStartOperationId(`op_${"8".repeat(32)}`));
const sessionId = value(validateManagedSessionId(`ses_${"9".repeat(32)}`));
const messageId = value(validateNativeMessageId(`msg_${"a".repeat(32)}`));
const token = value(validateFencingToken(21));
const arguments_: ValidatedStartArguments = {
  idempotencyKey: "start:additional",
  initialMessage: "work",
  title: "Worker",
};

function operation(step: StartStep = "creation"): StartOperation {
  return {
    id: operationId,
    workspaceKey,
    sourceSessionId,
    idempotencyKey: arguments_.idempotencyKey,
    argumentsSha256: "0".repeat(64) as StartOperation["argumentsSha256"],
    sessionId,
    nativeMessageId: messageId,
    creationState: step === "creation" ? "prepared" : "created",
    titleState: step === "title" ? "prepared" : step === "admission" ? "skipped" : "not_started",
    admissionState: step === "admission" ? "prepared" : "not_started",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function effectFixture(step: StartStep) {
  const initial = operation(step);
  const claimed = { ...initial, [`${step}State`]: "submitting", updatedAtMs: 2 } as StartOperation;
  const ports: SessionStartPorts = {
    readiness: { fencingToken: token, assertReady() {} },
    membership: {
      readCurrentRoots: async () => ({
        sourceTitle: undefined,
        sourceVisible: true,
        targetVisible: true,
      }),
    },
    approval: { requestStartApproval: async () => "approved" },
    starts: {
      claimStep: async () => ({ ok: true, operation: claimed, arguments: arguments_ }),
      restorePreparedClaim: async () => ({ ok: true, operation: initial }),
      releasePreparedReservation: async () => ({ ok: true, operation: initial }),
      rejectPreparedStart: async (
        input: Parameters<SessionStartPorts["starts"]["rejectPreparedStart"]>[0],
      ) => ({
        ok: true,
        operation: { ...initial, creationState: input.state },
      }),
      completeCreation: async (
        input: Parameters<SessionStartPorts["starts"]["completeCreation"]>[0],
      ) => ({
        ok: true,
        operation: {
          ...claimed,
          creationState: input.state,
          titleState: input.state === "created" ? "prepared" : "not_started",
          admissionState: input.state === "created" ? "prepared" : "not_started",
        },
      }),
      completeTitle: async (
        input: Parameters<SessionStartPorts["starts"]["completeTitle"]>[0],
      ) => ({ ok: true, operation: { ...claimed, titleState: input.state } }),
      completeAdmission: async (
        input: Parameters<SessionStartPorts["starts"]["completeAdmission"]>[0],
      ) => ({
        ok: true,
        operation: { ...claimed, admissionState: input.state },
      }),
    } as never,
    nativeStart: {
      reconcileRootSession: async () => "unknown",
      createRootSession: async () => "created",
      updateSessionTitle: async () => "updated",
      admitInitialMessage: async () => "admitted",
    },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    clock: { nowMs: () => 3 },
    ids: {} as never,
    digest: { sha256: async () => new Uint8Array(32) },
    policy: createSessionStartPolicy({ decision: "allow" }),
  };
  return { ports, initial, claimed };
}

const context = (abort = new AbortController().signal, deadlineMs = 100) => ({
  workspaceKey,
  sourceSessionId,
  abort,
  deadlineMs,
});

describe("session start effect crash boundaries", () => {
  test("restores a creation claim when cancellation arrives during membership revalidation", async () => {
    const current = effectFixture("creation");
    const controller = new AbortController();
    current.ports.membership.readCurrentRoots = async () => {
      controller.abort();
      return { sourceTitle: undefined, sourceVisible: true, targetVisible: true };
    };
    expect(
      await runStartCreation(current.ports, context(controller.signal), token, current.initial),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
  });

  test("preserves native ambiguity when the post-effect ownership read rejects", async () => {
    const current = effectFixture("creation");
    let checks = 0;
    current.ports.ownership.isCurrent = async () => {
      checks += 1;
      if (checks === 2) throw new Error("ownership read failed");
      return true;
    };
    expect(await runStartCreation(current.ports, context(), token, current.initial)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
  });

  test("maps title claim and completion failures without repeating native work", async () => {
    const claim = effectFixture("title");
    claim.ports.starts.claimStep = async () => ({ ok: false, code: "state_conflict" });
    expect(await runStartTitle(claim.ports, context(), token, claim.initial)).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });

    const completion = effectFixture("title");
    completion.ports.starts.completeTitle = async () => ({
      ok: false,
      code: "storage_unavailable",
    });
    expect(
      await runStartTitle(completion.ports, context(), token, completion.initial),
    ).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
  });

  test("rejects malformed native start admission outcomes", async () => {
    for (const native of [
      Object.create({ kind: "unknown" }),
      { kind: "admitted", admittedSeq: 1, observedAtMs: 2, [Symbol("extra")]: true },
      Object.defineProperty({ kind: "unknown" }, "extra", { enumerable: true, get: () => 1 }),
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("reflection");
          },
        },
      ),
    ]) {
      const current = effectFixture("admission");
      current.ports.nativeStart.admitInitialMessage = async () => native as never;
      await expect(
        runStartAdmission(current.ports, context(), token, current.initial),
      ).rejects.toThrow("malformed outcome");
    }
  });

  test("maps admission claim, pre-call, ownership, and completion boundaries", async () => {
    const noEffect = effectFixture("admission");
    const finished = { ...noEffect.initial, admissionState: "admitted" as const };
    expect(await runStartAdmission(noEffect.ports, context(), token, finished)).toEqual({
      ok: true,
      value: finished,
    });

    const claim = effectFixture("admission");
    claim.ports.starts.claimStep = async () => ({ ok: false, code: "quota_exceeded" });
    expect(await runStartAdmission(claim.ports, context(), token, claim.initial)).toMatchObject({
      ok: false,
    });

    const hidden = effectFixture("admission");
    hidden.ports.membership.readCurrentRoots = async () => ({
      sourceTitle: undefined,
      sourceVisible: false,
      targetVisible: true,
    });
    expect(await runStartAdmission(hidden.ports, context(), token, hidden.initial)).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible" },
    });

    const lost = effectFixture("admission");
    let reads = 0;
    lost.ports.ownership.isCurrent = async () => ++reads === 1;
    expect(await runStartAdmission(lost.ports, context(), token, lost.initial)).toMatchObject({
      ok: false,
      error: { code: "admission_unknown" },
    });

    for (const complete of [
      async () => {
        throw new Error("disk");
      },
      async () => ({ ok: false as const, code: "storage_unavailable" as const }),
    ]) {
      const current = effectFixture("admission");
      current.ports.starts.completeAdmission = complete as never;
      expect(
        await runStartAdmission(current.ports, context(), token, current.initial),
      ).toMatchObject({
        ok: false,
        error: { code: "admission_unknown" },
      });
    }
  });
});

describe("session start approval and orchestration boundaries", () => {
  test("allows policy-approved starts without asking and contains release failures", async () => {
    const allowed = effectFixture("creation");
    (allowed.ports as { policy: SessionStartPorts["policy"] }).policy = createSessionStartPolicy({
      decision: "allow",
    });
    let asked = 0;
    allowed.ports.approval.requestStartApproval = async () => {
      asked += 1;
      return "rejected";
    };
    expect(
      await approvePreparedStart(allowed.ports, context(), token, {
        operation: allowed.initial,
        argumentsSha256: allowed.initial.argumentsSha256,
      }),
    ).toEqual({ ok: true, value: true });
    expect(asked).toBe(0);

    const failed = effectFixture("creation");
    (failed.ports as { policy: SessionStartPorts["policy"] }).policy = createSessionStartPolicy({
      decision: "deny",
    });
    failed.ports.starts.rejectPreparedStart = async () => ({
      ok: false,
      code: "state_conflict",
    });
    expect(
      await approvePreparedStart(failed.ports, context(), token, {
        operation: failed.initial,
        argumentsSha256: failed.initial.argumentsSha256,
      }),
    ).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  });

  test("commits static policy denial without consulting approval", async () => {
    const current = effectFixture("creation");
    (current.ports as { policy: SessionStartPorts["policy"] }).policy = createSessionStartPolicy({
      decision: "deny",
    });
    expect(
      await approvePreparedStart(current.ports, context(), token, {
        operation: current.initial,
        argumentsSha256: current.initial.argumentsSha256,
      }),
    ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  function applicationFixture() {
    const current = effectFixture("creation");
    (current.ports as { ids: SessionStartPorts["ids"] }).ids = {
      startOperationId: () => operationId,
      managedSessionId: () => sessionId,
      nativeMessageId: () => messageId,
    } as never;
    current.ports.starts.isManagedSession = async () => false;
    current.ports.starts.createOrResume = async (input) => ({
      ok: true,
      operation: {
        ...current.initial,
        idempotencyKey: input.arguments.idempotencyKey,
        argumentsSha256: input.argumentsSha256,
      },
    });
    return current;
  }

  const applicationArguments = {
    idempotency_key: arguments_.idempotencyKey,
    initial_message: arguments_.initialMessage,
    title: arguments_.title,
  };

  test("validates every start argument before lifecycle effects", async () => {
    for (const args of [
      { ...applicationArguments, idempotency_key: "" },
      { ...applicationArguments, initial_message: "" },
      { ...applicationArguments, title: "" },
      { ...applicationArguments, agent: "" },
      { ...applicationArguments, model: "bad model" },
    ]) {
      expect(await startSession(applicationFixture().ports, context(), args)).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments" },
      });
    }
    expect(
      await startSession(
        applicationFixture().ports,
        context(new AbortController().signal, -1),
        applicationArguments,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  test("contains malformed recursion and persistence adapter results", async () => {
    const managed = applicationFixture();
    managed.ports.starts.isManagedSession = async () => "yes" as never;
    await expect(startSession(managed.ports, context(), applicationArguments)).rejects.toThrow(
      "malformed result",
    );

    const failed = applicationFixture();
    failed.ports.starts.createOrResume = async () => ({ ok: false, code: "rate_limited" });
    expect(await startSession(failed.ports, context(), applicationArguments)).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });
  });

  test("projects resumed terminal operations without approval or native work", async () => {
    const resumed = applicationFixture();
    resumed.ports.starts.createOrResume = async (input) => ({
      ok: true,
      operation: {
        ...resumed.initial,
        argumentsSha256: input.argumentsSha256,
        creationState: "created",
        titleState: "updated",
        admissionState: "admitted",
      },
    });
    expect(await startSession(resumed.ports, context(), applicationArguments)).toMatchObject({
      ok: true,
      value: { creationState: "created", admissionState: "admitted" },
    });
  });
});
