import { expect, test } from "bun:test";
import type {
  StartOperationPersistencePort,
  StartStep,
} from "../../../src/application/session-start-ports";
import { type SessionStartPorts, startSession } from "../../../src/application/start-session";
import { projectStartOutcome } from "../../../src/application/start-session-effects";
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

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:start-app"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const operationId = valid(validateStartOperationId(`op_${"1".repeat(32)}`));
const managedSessionId = valid(validateManagedSessionId(`ses_${"2".repeat(32)}`));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"3".repeat(32)}`));
const fencingToken = valid(validateFencingToken(1));

function persistence(
  calls: string[],
  arguments_: ValidatedStartArguments,
): StartOperationPersistencePort {
  let operation: StartOperation | undefined;
  const current = (): StartOperation => {
    if (!operation) throw new Error("operation is absent");
    return operation;
  };
  const change = (values: Partial<StartOperation>): StartOperation => {
    operation = { ...current(), ...values, updatedAtMs: current().updatedAtMs + 1 };
    return operation;
  };
  return {
    async createOrResume(input) {
      calls.push("persist");
      operation ??= {
        id: input.operationId,
        workspaceKey: input.workspaceKey,
        sourceSessionId: input.sourceSessionId,
        idempotencyKey: input.arguments.idempotencyKey,
        argumentsSha256: input.argumentsSha256,
        sessionId: input.sessionId,
        nativeMessageId: input.nativeMessageId,
        ...(input.arguments.agent === undefined ? {} : { requestedAgent: input.arguments.agent }),
        ...(input.arguments.model === undefined ? {} : { requestedModel: input.arguments.model }),
        titleRequested: input.arguments.title !== undefined,
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
      calls.push(`claim:${input.step}`);
      const states: Record<StartStep, Partial<StartOperation>> = {
        creation: { creationState: "submitting" },
        title: { titleState: "submitting" },
        admission: { admissionState: "submitting" },
      };
      return { ok: true, operation: change(states[input.step]), arguments: arguments_ };
    },
    async restorePreparedClaim(input) {
      const states: Record<StartStep, Partial<StartOperation>> = {
        creation: { creationState: "prepared" },
        title: { titleState: "prepared" },
        admission: { admissionState: "prepared" },
      };
      return { ok: true, operation: change(states[input.step]) };
    },
    async releasePreparedReservation() {
      return { ok: true, operation: current() };
    },
    async rejectPreparedStart(input) {
      return { ok: true, operation: change({ creationState: input.state }) };
    },
    async classifyStaleSubmitting() {
      return { ok: false, code: "state_conflict" };
    },
    async reconcileUnknownCreation(input) {
      return {
        ok: true,
        operation: change({
          creationState: input.outcome === "matching" ? "created" : "failed",
          ...(input.outcome === "matching"
            ? { titleState: "prepared", admissionState: "prepared" }
            : {}),
        }),
      };
    },
    async completeCreation(input) {
      calls.push(`complete:creation:${input.state}`);
      return {
        ok: true,
        operation: change({
          creationState: input.state,
          ...(input.state === "created"
            ? {
                titleState: arguments_.title === undefined ? "skipped" : "prepared",
                admissionState: "prepared",
              }
            : {}),
        }),
      };
    },
    async completeTitle(input) {
      calls.push(`complete:title:${input.state}`);
      return { ok: true, operation: change({ titleState: input.state }) };
    },
    async completeAdmission(input) {
      calls.push(`complete:admission:${input.state}`);
      return { ok: true, operation: change({ admissionState: input.state }) };
    },
    async listRecoverable() {
      return operation ? [operation] : [];
    },
    async collectRetention() {
      return { ok: true, deletedOperations: 0, deletedRateEvents: 0 };
    },
  };
}

function fixture(input: { creation?: "created" | "unknown"; title?: "updated" | "unknown" } = {}) {
  const calls: string[] = [];
  const arguments_: ValidatedStartArguments = {
    idempotencyKey: "start:app",
    initialMessage: "Do the work",
    title: "Worker",
  };
  const starts = persistence(calls, arguments_);
  const ports: SessionStartPorts = {
    readiness: {
      fencingToken,
      assertReady() {},
      ownershipLost() {
        calls.push("lifecycle:ownership_lost");
      },
    },
    membership: {
      async readCurrentRoots() {
        calls.push("visibility");
        return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
      },
    },
    approval: {
      async requestStartApproval() {
        calls.push("approval");
        return "approved";
      },
    },
    starts,
    nativeStart: {
      async reconcileRootSession() {
        return "unknown";
      },
      async createRootSession(request) {
        calls.push(`native:create:${request.sessionId}`);
        return input.creation ?? "created";
      },
      async updateSessionTitle() {
        calls.push("native:title");
        return input.title ?? "updated";
      },
      async admitInitialMessage(request) {
        calls.push(`native:admit:${request.nativeMessageId}:${request.message}`);
        return "admitted";
      },
    },
    ownership: {
      async acquire() {
        return fencingToken;
      },
      async isCurrent() {
        return true;
      },
    },
    clock: { nowMs: () => 10 },
    ids: {
      deliveryId() {
        throw new Error("not used");
      },
      requestId() {
        throw new Error("not used");
      },
      startOperationId: () => operationId,
      managedSessionId: () => managedSessionId,
      nativeMessageId: () => nativeMessageId,
    },
    digest: {
      async sha256() {
        return new Uint8Array(32);
      },
    },
    policy: createSessionStartPolicy({ decision: "allow" }),
  };
  return { calls, ports, arguments_ };
}

test("persists before approval and runs fenced create, title, and fixed-ID admission", async () => {
  const testFixture = fixture({ title: "unknown" });
  const result = await startSession(
    testFixture.ports,
    { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
    { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unexpected start failure");
  expect(result.value).toMatchObject({
    creationState: "created",
    titleState: "outcome_unknown",
    admissionState: "admitted",
  });
  expect(testFixture.calls).not.toContain("approval");
  expect(
    testFixture.calls.some((call) => call === `native:admit:${nativeMessageId}:Do the work`),
  ).toBe(true);
});

test("replays a policy-denied start deterministically without native effects", async () => {
  const testFixture = fixture();
  (testFixture.ports as { policy: SessionStartPorts["policy"] }).policy = createSessionStartPolicy({
    decision: "deny",
  });
  const invoke = () =>
    startSession(
      testFixture.ports,
      { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
      { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
    );
  const first = await invoke();
  const repeated = await invoke();
  expect(first).toMatchObject({
    ok: false,
    error: {
      code: "permission_denied",
      details: { operation: { creationState: "policy_denied" } },
    },
  });
  expect(repeated).toEqual(first);
  expect(testFixture.calls).not.toContain("approval");
  expect(testFixture.calls.some((call) => call.startsWith("native:"))).toBe(false);
});

test("exposes ambiguous creation and does not blindly run later effects", async () => {
  const testFixture = fixture({ creation: "unknown" });
  const result = await startSession(
    testFixture.ports,
    { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
    { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected ambiguous start");
  expect(result.error.code).toBe("native_outcome_unknown");
  expect(testFixture.calls).not.toContain("native:title");
  expect(testFixture.calls.some((call) => call.startsWith("native:admit"))).toBe(false);
});

test("stops the lifecycle instead of reacquiring after its recovered epoch is lost", async () => {
  const testFixture = fixture();
  testFixture.ports.ownership.isCurrent = async () => false;
  testFixture.ports.ownership.acquire = async () => {
    testFixture.calls.push("acquire");
    return valid(validateFencingToken(2));
  };
  const result = await startSession(
    testFixture.ports,
    { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
    { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  expect(testFixture.calls).toContain("lifecycle:ownership_lost");
  expect(testFixture.calls).not.toContain("acquire");
  expect(testFixture.calls.some((call) => call.startsWith("native:"))).toBe(false);
});

test("same-key retry reconciles ambiguity without retrying create and resumes continuation", async () => {
  const testFixture = fixture({ creation: "unknown" });
  const invoke = () =>
    startSession(
      testFixture.ports,
      { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
      { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
    );
  expect((await invoke()).ok).toBe(false);
  testFixture.ports.nativeStart.reconcileRootSession = async () => "matching";
  expect((await invoke()).ok).toBe(true);
  expect(testFixture.calls.filter((call) => call.startsWith("native:create"))).toHaveLength(1);
  expect(testFixture.calls).toContain("native:title");
  expect(testFixture.calls.some((call) => call.startsWith("native:admit"))).toBe(true);
});

test("native-port proven stable absence terminalizes an ambiguous create without replay", async () => {
  const testFixture = fixture({ creation: "unknown" });
  const invoke = () =>
    startSession(
      testFixture.ports,
      { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
      { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
    );
  expect((await invoke()).ok).toBe(false);
  testFixture.ports.nativeStart.reconcileRootSession = async () => "absent";
  expect(await invoke()).toMatchObject({
    ok: false,
    error: { code: "native_unavailable", details: { operation: { creationState: "failed" } } },
  });
  expect(testFixture.calls.filter((call) => call.startsWith("native:create"))).toHaveLength(1);
});

test("rejects explicit overrides when the exact allowlist is empty", async () => {
  const testFixture = fixture();
  const result = await startSession(
    testFixture.ports,
    { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
    { idempotency_key: "start:app", initial_message: "Do the work", agent: "worker" },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  expect(testFixture.calls).toHaveLength(0);
});

test("never projects any submitting start step as success", () => {
  const testFixture = fixture();
  const base: StartOperation = {
    id: operationId,
    workspaceKey,
    sourceSessionId,
    idempotencyKey: testFixture.arguments_.idempotencyKey,
    argumentsSha256: "0".repeat(64) as StartOperation["argumentsSha256"],
    sessionId: managedSessionId,
    nativeMessageId,
    creationState: "created",
    titleState: "updated",
    admissionState: "admitted",
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  expect(
    projectStartOutcome({
      ...base,
      creationState: "submitting",
      titleState: "not_started",
      admissionState: "not_started",
    }).ok,
  ).toBe(false);
  expect(projectStartOutcome({ ...base, titleState: "submitting" }).ok).toBe(false);
  expect(projectStartOutcome({ ...base, admissionState: "submitting" }).ok).toBe(false);
  expect(
    projectStartOutcome({
      ...base,
      titleState: "payload_unavailable",
      admissionState: "payload_unavailable",
    }),
  ).toMatchObject({ ok: false, error: { code: "start_payload_unavailable" } });
  expect(
    projectStartOutcome({
      ...base,
      creationState: "request_terminal",
      titleState: "skipped",
      admissionState: "payload_unavailable",
    }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "start_payload_unavailable",
      message:
        "The linked request became terminal before session creation; no managed root was started.",
    },
  });
});

test("commits authoritative creation even when caller visibility is lost immediately afterward", async () => {
  const testFixture = fixture();
  let visibilityReads = 0;
  testFixture.ports.membership.readCurrentRoots = async () => {
    visibilityReads += 1;
    return {
      sourceVisible: visibilityReads <= 2,
      targetVisible: visibilityReads <= 2,
      sourceTitle: "Source",
    };
  };
  const result = await startSession(
    testFixture.ports,
    { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
    { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "caller_not_visible" } });
  expect(testFixture.calls).toContain("complete:creation:created");
});

test("returns native ambiguity when creation completion persistence fails", async () => {
  const testFixture = fixture();
  testFixture.ports.starts.completeCreation = async () => ({
    ok: false,
    code: "storage_unavailable",
  });
  const result = await startSession(
    testFixture.ports,
    { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
    { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "native_outcome_unknown" } });
});

test("restores a pre-effect claim when the finite invocation control aborts", async () => {
  const testFixture = fixture();
  const controller = new AbortController();
  let visibilityReads = 0;
  testFixture.ports.membership.readCurrentRoots = async () => {
    visibilityReads += 1;
    if (visibilityReads === 1) controller.abort();
    return { sourceVisible: true, targetVisible: true, sourceTitle: "Source" };
  };
  const result = await startSession(
    testFixture.ports,
    { workspaceKey, sourceSessionId, abort: controller.signal, deadlineMs: 100 },
    { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
  expect(testFixture.calls.some((call) => call.startsWith("native:create"))).toBe(false);
});

test("treats claimed payload digest drift as a contract fault, not storage failure", async () => {
  const testFixture = fixture();
  let digests = 0;
  testFixture.ports.digest.sha256 = async () => {
    digests += 1;
    return new Uint8Array(32).fill(digests === 1 ? 0 : 1);
  };
  expect(
    startSession(
      testFixture.ports,
      { workspaceKey, sourceSessionId, abort: new AbortController().signal, deadlineMs: 100 },
      { idempotency_key: "start:app", initial_message: "Do the work", title: "Worker" },
    ),
  ).rejects.toThrow("digest");
});
