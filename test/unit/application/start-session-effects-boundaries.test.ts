import { describe, expect, test } from "bun:test";

import type { SessionStartPorts } from "../../../src/application/session-start-application";
import type { StartStep } from "../../../src/application/session-start-ports";
import {
  projectStartOutcome,
  runStartAdmission,
  runStartCreation,
  runStartTitle,
  startStoreFailure,
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

const workspaceKey = value(validateWorkspaceKey("workspace:start-effects"));
const sourceSessionId = value(validateSessionId("ses_source"));
const operationId = value(validateStartOperationId(`op_${"1".repeat(32)}`));
const sessionId = value(validateManagedSessionId(`ses_${"2".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"3".repeat(32)}`));
const token = value(validateFencingToken(1));
const arguments_: ValidatedStartArguments = {
  idempotencyKey: "start:effects",
  initialMessage: "work",
  title: "Worker",
};

function operation(step: StartStep): StartOperation {
  return {
    id: operationId,
    workspaceKey,
    sourceSessionId,
    idempotencyKey: arguments_.idempotencyKey,
    argumentsSha256: "0".repeat(64) as StartOperation["argumentsSha256"],
    sessionId,
    nativeMessageId,
    creationState: step === "creation" ? "prepared" : "created",
    titleState: step === "creation" ? "not_started" : step === "title" ? "prepared" : "skipped",
    admissionState: step === "creation" ? "not_started" : "prepared",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function fixture(step: StartStep) {
  const initial = operation(step);
  const claimed: StartOperation = {
    ...initial,
    [`${step}State`]: "submitting",
    updatedAtMs: 2,
  };
  const calls: string[] = [];
  const ports: SessionStartPorts = {
    readiness: { fencingToken: token, assertReady() {} },
    membership: {
      async readCurrentRoots() {
        return { sourceVisible: true, targetVisible: true, sourceTitle: "source" };
      },
    },
    approval: { requestStartApproval: async () => "approved" },
    starts: {
      async createOrResume() {
        throw new Error("unused");
      },
      async isManagedSession() {
        return false;
      },
      async claimStep() {
        calls.push("claim");
        return { ok: true, operation: claimed, arguments: arguments_ };
      },
      async restorePreparedClaim() {
        calls.push("restore");
        return { ok: true, operation: initial };
      },
      async releasePreparedReservation() {
        calls.push("release");
        return { ok: true, operation: initial };
      },
      async rejectPreparedStart() {
        throw new Error("unused");
      },
      async classifyStaleSubmitting() {
        throw new Error("unused");
      },
      async reconcileUnknownCreation() {
        throw new Error("unused");
      },
      async completeCreation(input) {
        calls.push("complete");
        return {
          ok: true,
          operation: {
            ...claimed,
            creationState: input.state,
            titleState: input.state === "created" ? "prepared" : "not_started",
            admissionState: input.state === "created" ? "prepared" : "not_started",
            updatedAtMs: 3,
          },
        };
      },
      async completeTitle(input) {
        calls.push("complete");
        return {
          ok: true,
          operation: { ...claimed, titleState: input.state, updatedAtMs: 3 },
        };
      },
      async completeAdmission(input) {
        calls.push("complete");
        return {
          ok: true,
          operation: { ...claimed, admissionState: input.state, updatedAtMs: 3 },
        };
      },
      async listRecoverable() {
        return [];
      },
      async collectRetention() {
        return { ok: true, deletedOperations: 0, deletedRateEvents: 0 };
      },
    },
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
  return { ports, initial, claimed, calls };
}

const context = () => ({
  workspaceKey,
  sourceSessionId,
  abort: new AbortController().signal,
  deadlineMs: 100,
});

describe("session-start projection and creation effect boundaries", () => {
  test("projects definitive creation and admission failures and rejects unknown store codes", () => {
    expect(
      projectStartOutcome({ ...operation("creation"), creationState: "failed" }),
    ).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
    expect(
      projectStartOutcome({
        ...operation("admission"),
        admissionState: "failed",
      }),
    ).toMatchObject({ ok: false, error: { code: "admission_failed" } });
    expect(() => startStoreFailure("future" as never)).toThrow("unknown failure");
  });

  test("restores claims when cancellation, hidden membership, or ownership blocks creation", async () => {
    const cancelled = fixture("creation");
    const controller = new AbortController();
    controller.abort();
    expect(
      await runStartCreation(
        cancelled.ports,
        { ...context(), abort: controller.signal },
        token,
        cancelled.initial,
      ),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    expect(cancelled.calls).toEqual(["claim", "restore", "release"]);

    const hidden = fixture("creation");
    hidden.ports.membership.readCurrentRoots = async () => {
      throw new Error("membership unavailable");
    };
    expect(await runStartCreation(hidden.ports, context(), token, hidden.initial)).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible" },
    });

    const malformed = fixture("creation");
    malformed.ports.membership.readCurrentRoots = async () => ({
      sourceTitle: undefined,
      get sourceVisible(): boolean {
        throw new Error("private membership getter failure");
      },
      targetVisible: true,
    });
    expect(
      await runStartCreation(malformed.ports, context(), token, malformed.initial),
    ).toMatchObject({ ok: false, error: { code: "caller_not_visible" } });

    const lost = fixture("creation");
    lost.ports.ownership.isCurrent = async () => false;
    expect(await runStartCreation(lost.ports, context(), token, lost.initial)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
    expect(lost.calls).toEqual(["claim", "restore"]);
  });

  test("maps claim, restore, and release faults before native creation", async () => {
    const claimThrow = fixture("creation");
    claimThrow.ports.starts.claimStep = async () => {
      throw new Error("disk");
    };
    expect(
      await runStartCreation(claimThrow.ports, context(), token, claimThrow.initial),
    ).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    const claimFailure = fixture("creation");
    claimFailure.ports.starts.claimStep = async () => ({ ok: false, code: "state_conflict" });
    expect(
      await runStartCreation(claimFailure.ports, context(), token, claimFailure.initial),
    ).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
    for (const boundary of ["restore", "release"] as const) {
      const failed = fixture("creation");
      const controller = new AbortController();
      controller.abort();
      failed.ports.starts[
        boundary === "restore" ? "restorePreparedClaim" : "releasePreparedReservation"
      ] = async () => {
        throw new Error("disk");
      };
      expect(
        await runStartCreation(
          failed.ports,
          { ...context(), abort: controller.signal },
          token,
          failed.initial,
        ),
      ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    }
  });

  test("treats malformed claims and native creation outcomes as contract faults", async () => {
    const unrelated = fixture("creation");
    unrelated.ports.starts.claimStep = async () => ({
      ok: true,
      operation: { ...unrelated.claimed, sessionId: sourceSessionId },
      arguments: arguments_,
    });
    await expect(
      runStartCreation(unrelated.ports, context(), token, unrelated.initial),
    ).rejects.toThrow("unrelated claim");
    const malformed = fixture("creation");
    malformed.ports.nativeStart.createRootSession = async () => "future" as never;
    await expect(
      runStartCreation(malformed.ports, context(), token, malformed.initial),
    ).rejects.toThrow("unknown outcome");
  });

  test("preserves creation ambiguity across ownership and completion faults", async () => {
    const lost = fixture("creation");
    let reads = 0;
    lost.ports.ownership.isCurrent = async () => ++reads === 1;
    expect(await runStartCreation(lost.ports, context(), token, lost.initial)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
    for (const completion of ["throw", "failure"] as const) {
      const failed = fixture("creation");
      failed.ports.starts.completeCreation =
        completion === "throw"
          ? async () => {
              throw new Error("disk");
            }
          : async () => ({ ok: false, code: "storage_unavailable" });
      expect(await runStartCreation(failed.ports, context(), token, failed.initial)).toMatchObject({
        ok: false,
        error: { code: "native_outcome_unknown" },
      });
    }
    const malformed = fixture("creation");
    malformed.ports.starts.completeCreation = async () => ({
      ok: true,
      operation: { ...malformed.claimed, creationState: "submitting" },
    });
    await expect(
      runStartCreation(malformed.ports, context(), token, malformed.initial),
    ).rejects.toThrow("completion result");
  });
});

describe("session-start title and admission effect boundaries", () => {
  test("covers title rejection, missing payload, and ambiguous completion boundaries", async () => {
    const missing = fixture("title");
    missing.ports.starts.claimStep = async () => ({
      ok: true,
      operation: missing.claimed,
      arguments: { idempotencyKey: arguments_.idempotencyKey, initialMessage: "work" },
    });
    await expect(runStartTitle(missing.ports, context(), token, missing.initial)).rejects.toThrow(
      "no title",
    );

    for (const native of ["definitive_rejection", "unknown"] as const) {
      const current = fixture("title");
      current.ports.nativeStart.updateSessionTitle = async () => native;
      expect((await runStartTitle(current.ports, context(), token, current.initial)).ok).toBe(true);
    }
    const malformed = fixture("title");
    malformed.ports.nativeStart.updateSessionTitle = async () => "future" as never;
    await expect(
      runStartTitle(malformed.ports, context(), token, malformed.initial),
    ).rejects.toThrow("unknown outcome");
    const completion = fixture("title");
    completion.ports.starts.completeTitle = async () => {
      throw new Error("disk");
    };
    expect(
      await runStartTitle(completion.ports, context(), token, completion.initial),
    ).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
    const lost = fixture("title");
    let ownershipReads = 0;
    lost.ports.ownership.isCurrent = async () => ++ownershipReads === 1;
    expect(await runStartTitle(lost.ports, context(), token, lost.initial)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
    const malformedCompletion = fixture("title");
    malformedCompletion.ports.starts.completeTitle = async () => ({
      ok: true,
      operation: { ...malformedCompletion.claimed, titleState: "prepared" },
    });
    await expect(
      runStartTitle(malformedCompletion.ports, context(), token, malformedCompletion.initial),
    ).rejects.toThrow("completion result");
  });

  test("validates exact native start admission outcomes and maps terminal outcomes", async () => {
    for (const native of ["unknown", "definitive_rejection", "admitted"] as const) {
      const current = fixture("admission");
      current.ports.nativeStart.admitInitialMessage = async () => native;
      expect((await runStartAdmission(current.ports, context(), token, current.initial)).ok).toBe(
        true,
      );
    }
    const overrides = fixture("admission");
    overrides.ports.starts.claimStep = async () => ({
      ok: true,
      operation: overrides.claimed,
      arguments: { ...arguments_, agent: "worker", model: "openai/gpt-5" },
    });
    overrides.ports.nativeStart.admitInitialMessage = async (input) => {
      expect(input).toMatchObject({ agent: "worker", model: "openai/gpt-5" });
      return "admitted";
    };
    expect((await runStartAdmission(overrides.ports, context(), token, overrides.initial)).ok).toBe(
      true,
    );
    for (const native of [null, [], {}, "future", new String("unknown")]) {
      const malformed = fixture("admission");
      malformed.ports.nativeStart.admitInitialMessage = async () => native as never;
      await expect(
        runStartAdmission(malformed.ports, context(), token, malformed.initial),
      ).rejects.toThrow("malformed outcome");
    }
    const completion = fixture("admission");
    completion.ports.starts.completeAdmission = async () => ({
      ok: true,
      operation: { ...completion.claimed, admissionState: "prepared" },
    });
    await expect(
      runStartAdmission(completion.ports, context(), token, completion.initial),
    ).rejects.toThrow("completion result");
  });
});
