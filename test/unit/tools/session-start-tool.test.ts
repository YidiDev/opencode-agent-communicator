import { expect, test } from "bun:test";

import type { StartStep } from "../../../src/application/session-start-ports";
import type { SessionStartPorts } from "../../../src/application/start-session";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { StartOperation, ValidatedStartArguments } from "../../../src/domain/session-start";
import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { ToolContractFault } from "../../../src/tools/contracts";
import { createSessionStartTool } from "../../../src/tools/session-start";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:start-tool"));
const fencingToken = valid(validateFencingToken(1));
const operationId = valid(validateStartOperationId(`op_${"1".repeat(32)}`));
const managedSessionId = valid(validateManagedSessionId(`ses_${"2".repeat(32)}`));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"3".repeat(32)}`));

function ports(creation: "created" | "unknown" = "created"): Omit<SessionStartPorts, "approval"> {
  let operation: StartOperation | undefined;
  let arguments_: ValidatedStartArguments | undefined;
  const current = () => {
    if (!operation) throw new Error("operation is absent");
    return operation;
  };
  const update = (values: Partial<StartOperation>) => {
    operation = { ...current(), ...values, updatedAtMs: current().updatedAtMs + 1 };
    return operation;
  };
  return {
    readiness: { fencingToken, assertReady() {} },
    membership: {
      async readCurrentRoots() {
        return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
      },
    },
    starts: {
      async createOrResume(input) {
        arguments_ = input.arguments;
        operation = {
          id: input.operationId,
          workspaceKey: input.workspaceKey,
          sourceSessionId: input.sourceSessionId,
          idempotencyKey: input.arguments.idempotencyKey,
          argumentsSha256: input.argumentsSha256,
          sessionId: input.sessionId,
          nativeMessageId: input.nativeMessageId,
          creationState: "prepared",
          titleState: "not_started",
          admissionState: "not_started",
          createdAtMs: input.nowMs,
          updatedAtMs: input.nowMs,
        };
        return { ok: true, operation };
      },
      async isManagedSession() {
        return false;
      },
      async claimStep(input) {
        const states: Record<StartStep, Partial<StartOperation>> = {
          creation: { creationState: "submitting" },
          title: { titleState: "submitting" },
          admission: { admissionState: "submitting" },
        };
        if (!arguments_) throw new Error("arguments are absent");
        return { ok: true, operation: update(states[input.step]), arguments: arguments_ };
      },
      async restorePreparedClaim() {
        return { ok: false, code: "state_conflict" };
      },
      async releasePreparedReservation() {
        return { ok: true, operation: current() };
      },
      async rejectPreparedStart(input) {
        return { ok: true, operation: update({ creationState: input.state }) };
      },
      async classifyStaleSubmitting() {
        return { ok: false, code: "state_conflict" };
      },
      async reconcileUnknownCreation() {
        return { ok: false, code: "state_conflict" };
      },
      async completeCreation(input) {
        return {
          ok: true,
          operation: update({
            creationState: input.state,
            ...(input.state === "created"
              ? { titleState: "skipped", admissionState: "prepared" }
              : {}),
          }),
        };
      },
      async completeTitle(input) {
        return { ok: true, operation: update({ titleState: input.state }) };
      },
      async completeAdmission(input) {
        return { ok: true, operation: update({ admissionState: input.state }) };
      },
      async listRecoverable() {
        return operation ? [operation] : [];
      },
      async collectRetention() {
        return { ok: true, deletedOperations: 0, deletedRateEvents: 0 };
      },
    },
    nativeStart: {
      async reconcileRootSession() {
        return "unknown";
      },
      async createRootSession() {
        return creation;
      },
      async updateSessionTitle() {
        return "updated";
      },
      async admitInitialMessage() {
        return "admitted";
      },
    },
    ownership: { acquire: async () => fencingToken, isCurrent: async () => true },
    clock: { nowMs: () => 10 },
    ids: {
      deliveryId: () => {
        throw new Error("not used");
      },
      requestId: () => {
        throw new Error("not used");
      },
      startOperationId: () => operationId,
      managedSessionId: () => managedSessionId,
      nativeMessageId: () => nativeMessageId,
    },
    digest: { sha256: async () => new Uint8Array(32) },
    policy: createSessionStartPolicy(),
  };
}

function context(sessionID = "ses_source") {
  return {
    sessionID,
    messageID: "msg_invocation",
    abort: new AbortController().signal,
    ask: async () => undefined,
  };
}

test("executes an approved start and emits only the public operation projection", async () => {
  const tool = createSessionStartTool(ports(), workspaceKeyScope(100));
  const output = JSON.parse(
    await tool.execute(
      { idempotency_key: "tool:start", initial_message: "Do the work" },
      context(),
    ),
  );
  expect(output).toMatchObject({
    ok: true,
    value: {
      creation_state: "created",
      title_state: "skipped",
      admission_state: "admitted",
    },
  });
  expect(output.value).not.toHaveProperty("workspaceKey");
});

test("retains a safe operation summary on an ambiguous native creation", async () => {
  const tool = createSessionStartTool(ports("unknown"), workspaceKeyScope(100));
  const output = JSON.parse(
    await tool.execute(
      { idempotency_key: "tool:start", initial_message: "Do the work" },
      context(),
    ),
  );
  expect(output).toMatchObject({
    ok: false,
    error: {
      code: "native_outcome_unknown",
      details: { operation: { creation_state: "outcome_unknown" } },
    },
  });
  expect(JSON.stringify(output)).not.toContain("Do the work");
});

test("bounds a membership read immediately before a prepared native effect", async () => {
  const configured = ports();
  const controller = new AbortController();
  let reads = 0;
  let claimed: StartOperation | undefined;
  const tool = createSessionStartTool(
    {
      ...configured,
      clock: { nowMs: Date.now },
      policy: createSessionStartPolicy({ decision: "allow" }),
      starts: {
        ...configured.starts,
        async claimStep(input) {
          const result = await configured.starts.claimStep(input);
          if (result.ok) claimed = result.operation;
          return result;
        },
        async restorePreparedClaim() {
          if (!claimed) throw new Error("claim is absent");
          return {
            ok: true as const,
            operation: { ...claimed, creationState: "prepared" as const },
          };
        },
      },
      membership: {
        async readCurrentRoots() {
          reads += 1;
          if (reads === 1) {
            return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
          }
          controller.abort();
          return new Promise<never>(() => undefined);
        },
      },
    },
    { workspaceKey, invocationDeadlineMs: () => Date.now() + 10_000 },
  );
  const pending = tool.execute(
    { idempotency_key: "tool:bounded-effect", initial_message: "Do the work" },
    { ...context(), abort: controller.signal },
  );
  const output = JSON.parse(await pending);
  expect(reads).toBe(2);
  expect(output).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
});

test("fails closed for unavailable deadlines and serializes malformed callers", async () => {
  for (const deadline of [() => Number.NaN, () => -1]) {
    const tool = createSessionStartTool(ports(), {
      workspaceKey,
      invocationDeadlineMs: deadline,
    });
    await expect(
      tool.execute({ idempotency_key: "tool:start", initial_message: "Do the work" }, context()),
    ).rejects.toBeInstanceOf(ToolContractFault);
  }
  const throwing = createSessionStartTool(ports(), {
    workspaceKey,
    invocationDeadlineMs: () => {
      throw new Error("private clock fault");
    },
  });
  await expect(
    throwing.execute({ idempotency_key: "tool:start", initial_message: "Do the work" }, context()),
  ).rejects.toBeInstanceOf(ToolContractFault);
  const callerFailure = JSON.parse(
    await createSessionStartTool(ports(), workspaceKeyScope(100)).execute(
      { idempotency_key: "tool:start", initial_message: "Do the work" },
      context("bad"),
    ),
  );
  expect(callerFailure).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
});

function workspaceKeyScope(deadlineMs: number) {
  return { workspaceKey, invocationDeadlineMs: () => deadlineMs };
}
