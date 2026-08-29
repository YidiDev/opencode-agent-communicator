import { describe, expect, test } from "bun:test";

import { recoverSessionStarts } from "../../../src/application/recover-session-starts";
import type { CompleteRequestDeliveryInput } from "../../../src/application/request-ports";
import type { StartOperationPersistencePort } from "../../../src/application/session-start-ports";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import type { StartOperation } from "../../../src/domain/session-start";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const fencingToken = value(validateFencingToken(3));
const workspaceKey = value(validateWorkspaceKey("workspace:start-recovery"));
const sourceSessionId = value(validateSessionId("ses_source"));

function operation(
  index: number,
  state: "prepared" | "creation" | "title" | "admission" | "unknown",
) {
  const submitting = state === "creation" || state === "title" || state === "admission";
  return {
    id: value(validateStartOperationId(`op_${String(index).padStart(32, "0")}`)),
    workspaceKey,
    sourceSessionId,
    idempotencyKey: `recovery:${index}`,
    argumentsSha256: "0".repeat(64) as StartOperation["argumentsSha256"],
    sessionId: value(validateManagedSessionId(`ses_${String(index).padStart(32, "1")}`)),
    nativeMessageId: value(validateNativeMessageId(`msg_${String(index).padStart(32, "2")}`)),
    creationState:
      state === "creation" ? "submitting" : state === "unknown" ? "outcome_unknown" : "prepared",
    titleState: state === "title" ? "submitting" : "not_started",
    admissionState: state === "admission" ? "submitting" : "not_started",
    createdAtMs: 1,
    updatedAtMs: submitting ? 2 : 1,
  } as StartOperation;
}

describe("session-start crash recovery", () => {
  test("classifies every durable crash boundary without replaying effects", async () => {
    const steps: string[] = [];
    const starts = {
      async listRecoverable() {
        return [
          operation(1, "prepared"),
          operation(2, "creation"),
          operation(3, "title"),
          operation(4, "admission"),
        ];
      },
      async classifyStaleSubmitting(input: { step: string }) {
        steps.push(input.step);
        return { ok: true as const, operation: operation(9, "prepared") };
      },
    } as unknown as StartOperationPersistencePort;

    expect(
      await recoverSessionStarts(starts, { nowMs: () => 7 }, { fencingToken, workspaceKey }),
    ).toEqual({
      preparedAwaitingInvocationApproval: 1,
      creationOutcomesUnknown: 1,
      titleOutcomesUnknown: 1,
      admissionsUnknown: 1,
    });
    expect(steps).toEqual(["creation", "title", "admission"]);
  });

  test("rejects unsafe limits, inconclusive short pages, and failed classifications", async () => {
    const base = {
      async listRecoverable() {
        return [operation(1, "creation")];
      },
      async classifyStaleSubmitting() {
        return { ok: false as const, code: "storage_unavailable" as const };
      },
    } as unknown as StartOperationPersistencePort;
    await expect(
      recoverSessionStarts(base, { nowMs: () => 1 }, { fencingToken, workspaceKey, limit: 0 }),
    ).rejects.toThrow("immutable ceiling");
    await expect(
      recoverSessionStarts(base, { nowMs: () => 1 }, { fencingToken, workspaceKey, limit: 1 }),
    ).rejects.toThrow("cannot prove");

    const failed = {
      ...base,
      async listRecoverable() {
        return [operation(1, "creation")];
      },
    } as StartOperationPersistencePort;
    await expect(
      recoverSessionStarts(failed, { nowMs: () => 1 }, { fencingToken, workspaceKey }),
    ).rejects.toThrow("could not be committed");
  });

  test("startup authoritatively reconciles existing unknown creation without replaying create", async () => {
    const reconciled: string[] = [];
    const starts = {
      async listRecoverable() {
        return [operation(5, "unknown")];
      },
      async reconcileUnknownCreation(input: { outcome: string }) {
        reconciled.push(input.outcome);
        return { ok: true as const, operation: operation(5, "prepared") };
      },
    } as unknown as StartOperationPersistencePort;
    const summary = await recoverSessionStarts(
      starts,
      { nowMs: () => 8 },
      {
        fencingToken,
        workspaceKey,
        nativeStart: {
          reconcileRootSession: async () => "matching",
        } as never,
      },
    );
    expect(summary.creationOutcomesUnknown).toBe(0);
    expect(reconciled).toEqual(["matching"]);
  });
});

describe("linked request-start crash recovery", () => {
  test("resumes an approved prepared composite and settles its initial request once", async () => {
    let current = operation(8, "prepared");
    let now = 10;
    const requestId = value(validateRequestId(`req_${"8".repeat(32)}`));
    const request = {
      id: requestId,
      workspaceKey,
      sourceSessionId,
      targetSessionId: current.sessionId,
      nativeMessageId: current.nativeMessageId,
      deliveryMode: "initial",
      linkedStartOperationId: current.id,
      kind: "wait",
      resolutionState: "pending",
      deliveryState: "submitting",
      resultState: "none",
      payloadByteLength: 1,
      payloadSha256: "0".repeat(64),
      createdAtMs: 1,
      updatedAtMs: 2,
      deadlineAtMs: 1_000,
      submittedAtMs: 2,
    } as RequestMetadata;
    const native: string[] = [];
    const completions: string[] = [];
    const starts = {
      async listRecoverable() {
        return [current];
      },
      async claimStep(input: { step: "creation" | "title" | "admission" }) {
        current = {
          ...current,
          [`${input.step}State`]: "submitting",
          updatedAtMs: now++,
        };
        return {
          ok: true as const,
          operation: current,
          arguments: { idempotencyKey: current.idempotencyKey, initialMessage: "envelope" },
        };
      },
      async completeCreation() {
        current = {
          ...current,
          creationState: "created",
          titleState: "skipped",
          admissionState: "prepared",
          updatedAtMs: now++,
        };
        return { ok: true as const, operation: current };
      },
      async completeAdmission() {
        current = { ...current, admissionState: "admitted", updatedAtMs: now++ };
        return { ok: true as const, operation: current };
      },
    } as unknown as StartOperationPersistencePort;
    const summary = await recoverSessionStarts(
      starts,
      { nowMs: () => now++ },
      {
        fencingToken,
        workspaceKey,
        requestStarts: {
          async readSessionRequestStart() {
            return { ok: true, found: false };
          },
          async readSessionRequestStartByOperation() {
            return { operation: current, request };
          },
          async createOrResumeSessionRequestStart() {
            throw new Error("not used");
          },
        },
        requests: {
          async claimPrepared() {
            throw new Error("an already-claimed initial request must not be claimed again");
          },
          async completeDelivery(input: CompleteRequestDeliveryInput) {
            completions.push(input.outcome);
            return { ok: true, request };
          },
        } as never,
        membership: {
          async readCurrentRoots() {
            return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
          },
        },
        ownership: { acquire: async () => fencingToken, isCurrent: async () => true },
        digest: { sha256: async () => new Uint8Array(32) },
        nativeStart: {
          async createRootSession() {
            native.push("create");
            return "created";
          },
          async reconcileRootSession() {
            return "matching";
          },
          async updateSessionTitle() {
            return "updated";
          },
          async admitInitialMessage() {
            native.push("admit");
            return "admitted";
          },
        },
      },
    );
    expect(summary.preparedAwaitingInvocationApproval).toBe(0);
    expect(native).toEqual(["create", "admit"]);
    expect(completions).toEqual(["admitted"]);
  });

  test("never replays a stale submitting initial admission", async () => {
    let current: StartOperation = {
      ...operation(9, "prepared"),
      creationState: "created" as const,
      titleState: "skipped" as const,
      admissionState: "prepared" as const,
    };
    const request = {
      id: value(validateRequestId(`req_${"9".repeat(32)}`)),
      workspaceKey,
      sourceSessionId,
      targetSessionId: current.sessionId,
      nativeMessageId: current.nativeMessageId,
      deliveryMode: "initial",
      linkedStartOperationId: current.id,
      kind: "wait",
      resolutionState: "pending",
      deliveryState: "delivery_unknown",
      resultState: "none",
      payloadByteLength: 1,
      payloadSha256: "0".repeat(64),
      createdAtMs: 1,
      updatedAtMs: 3,
      deadlineAtMs: 1_000,
      submittedAtMs: 2,
      deliveryUnknownAtMs: 3,
    } as RequestMetadata;
    let nativeAdmissions = 0;
    const starts = {
      async listRecoverable() {
        return [current];
      },
      async claimStep() {
        current = { ...current, admissionState: "submitting", updatedAtMs: 4 };
        return {
          ok: true as const,
          operation: current,
          arguments: { idempotencyKey: current.idempotencyKey, initialMessage: "envelope" },
        };
      },
      async completeAdmission() {
        current = { ...current, admissionState: "admission_unknown", updatedAtMs: 5 };
        return { ok: true as const, operation: current };
      },
    } as unknown as StartOperationPersistencePort;
    await recoverSessionStarts(
      starts,
      { nowMs: () => 5 },
      {
        fencingToken,
        workspaceKey,
        requestStarts: {
          async readSessionRequestStart() {
            return { ok: true, found: false };
          },
          async readSessionRequestStartByOperation() {
            return { operation: current, request };
          },
          async createOrResumeSessionRequestStart() {
            throw new Error("not used");
          },
        },
        requests: {} as never,
        membership: {
          async readCurrentRoots() {
            return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
          },
        },
        ownership: { acquire: async () => fencingToken, isCurrent: async () => true },
        digest: { sha256: async () => new Uint8Array(32) },
        nativeStart: {
          createRootSession: async () => "created",
          reconcileRootSession: async () => "matching",
          updateSessionTitle: async () => "updated",
          async admitInitialMessage() {
            nativeAdmissions += 1;
            return "admitted";
          },
        },
      },
    );
    expect(nativeAdmissions).toBe(0);
    expect(current.admissionState).toBe("admission_unknown");
  });
});

describe("session-start reconciliation recovery", () => {
  test("preserves unknown creation for an inconclusive native lookup and commits absence or collision", async () => {
    for (const outcome of ["unknown", "absent", "collision"] as const) {
      const reconciled: string[] = [];
      const nativeInputs: unknown[] = [];
      const starts = {
        async listRecoverable() {
          return [
            {
              ...operation(6, "unknown"),
              requestedAgent: "build",
              requestedModel: "provider/model",
            },
          ];
        },
        async reconcileUnknownCreation(input: { outcome: string }) {
          reconciled.push(input.outcome);
          return { ok: true as const, operation: operation(6, "prepared") };
        },
      } as unknown as StartOperationPersistencePort;
      const summary = await recoverSessionStarts(
        starts,
        { nowMs: () => 9 },
        {
          fencingToken,
          workspaceKey,
          nativeStart: {
            async reconcileRootSession(input: unknown) {
              nativeInputs.push(input);
              return outcome;
            },
          } as never,
        },
      );

      expect(nativeInputs).toHaveLength(1);
      expect(nativeInputs[0]).toMatchObject({
        sessionId: operation(6, "unknown").sessionId,
        agent: "build",
        model: "provider/model",
      });
      expect(reconciled).toEqual(outcome === "unknown" ? [] : [outcome]);
      expect(summary.creationOutcomesUnknown).toBe(outcome === "unknown" ? 1 : 0);
    }
  });

  test("fails closed on malformed native reconciliation and an uncommitted authoritative result", async () => {
    const starts = {
      async listRecoverable() {
        return [operation(7, "unknown")];
      },
      async reconcileUnknownCreation() {
        return { ok: false as const, code: "storage_unavailable" as const };
      },
    } as unknown as StartOperationPersistencePort;

    await expect(
      recoverSessionStarts(
        starts,
        { nowMs: () => 10 },
        {
          fencingToken,
          workspaceKey,
          nativeStart: { reconcileRootSession: async () => "malformed" } as never,
        },
      ),
    ).rejects.toThrow("malformed outcome");
    await expect(
      recoverSessionStarts(
        starts,
        { nowMs: () => 10 },
        {
          fencingToken,
          workspaceKey,
          nativeStart: { reconcileRootSession: async () => "absent" } as never,
        },
      ),
    ).rejects.toThrow("could not be committed");
  });
});
