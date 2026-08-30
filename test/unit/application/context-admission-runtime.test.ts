import { expect, test } from "bun:test";

import {
  ContextAdmissionRuntime,
  contextAdmissionRuntimeMaximumWaitersHardCeiling,
  notifyContextAdmissionSafely,
} from "../../../src/application/context-admission-runtime";
import { validateDeliveryId, validateRequestId } from "../../../src/domain/generated-ids";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const sourceSessionId = valid(validateSessionId("ses_source"));
const workspaceKey = valid(validateWorkspaceKey("context-runtime"));
const deliveryId = valid(validateDeliveryId(`dlv_${"a".repeat(32)}`));
const requestId = valid(validateRequestId(`req_${"b".repeat(32)}`));

function attach(runtime: ContextAdmissionRuntime, kind: "message" | "request" = "message") {
  return runtime.attach({
    id: kind === "message" ? deliveryId : requestId,
    kind,
    sourceSessionId,
    workspaceKey,
  });
}

async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  return !settled;
}

test("routes matching settlements to every attached observer", async () => {
  const runtime = new ContextAdmissionRuntime();
  const matching = attach(runtime);
  const duplicate = attach(runtime);

  runtime.notifyContextSettled({ id: deliveryId, kind: "message", state: "context_admitted" });

  expect(await matching.outcome).toEqual({
    outcome: "settled",
    event: { id: deliveryId, kind: "message", state: "context_admitted" },
  });
  expect((await duplicate.outcome).outcome).toBe("settled");
  matching.detach();
  duplicate.detach();
});

test("ignores unknown, malformed, and post-stop notifications", async () => {
  const runtime = new ContextAdmissionRuntime();
  expect(
    runtime.notifyContextSettled({ id: requestId, kind: "request", state: "failed" }),
  ).toBeUndefined();
  const registration = attach(runtime);
  runtime.notifyContextSettled({ id: requestId, kind: "message", state: "failed" });
  runtime.notifyContextSettled({ id: deliveryId, kind: "invalid", state: "failed" } as never);
  runtime.notifyContextSettled({ id: deliveryId, kind: "message", state: "prepared" } as never);
  runtime.notifyContextSettled({
    id: deliveryId,
    kind: "message",
    state: "awaiting_context",
  } as never);
  expect(await stillPending(registration.outcome)).toBe(true);
  runtime.stop("shutdown");
  runtime.notifyContextSettled({ id: deliveryId, kind: "message", state: "failed" });
  expect(await registration.outcome).toEqual({ outcome: "shutdown" });
});

test("detach is idempotent, removes routing, and releases exact capacity", async () => {
  const runtime = new ContextAdmissionRuntime(1);
  const removed = attach(runtime);
  expect(() => attach(runtime, "request")).toThrow(RangeError);
  removed.detach();
  removed.detach();
  runtime.notifyContextSettled({ id: deliveryId, kind: "message", state: "failed" });
  expect(await stillPending(removed.outcome)).toBe(true);
  const replacement = attach(runtime, "request");
  runtime.notifyContextSettled({ id: requestId, kind: "request", state: "cancelled" });
  expect((await replacement.outcome).outcome).toBe("settled");
  replacement.detach();
});

test("stop aborts effects once, settles all waiters, and preserves its first reason", async () => {
  const runtime = new ContextAdmissionRuntime();
  const message = attach(runtime);
  const request = attach(runtime, "request");
  runtime.stop("ownership_lost");
  runtime.stop("shutdown");
  expect(runtime.effectSignal.aborted).toBe(true);
  expect(runtime.effectSignal.reason).toBe("ownership_lost");
  expect(await message.outcome).toEqual({ outcome: "ownership_lost" });
  expect(await request.outcome).toEqual({ outcome: "ownership_lost" });
  const late = attach(runtime);
  expect(await late.outcome).toEqual({ outcome: "ownership_lost" });
  late.detach();
});

test("constructor and attachment validation fail closed", () => {
  for (const maximum of [
    0,
    1.5,
    Number.NaN,
    contextAdmissionRuntimeMaximumWaitersHardCeiling + 1,
  ]) {
    expect(() => new ContextAdmissionRuntime(maximum)).toThrow(RangeError);
  }
  const runtime = new ContextAdmissionRuntime();
  const base = { id: deliveryId, kind: "message", sourceSessionId, workspaceKey } as const;
  for (const malformed of [
    { ...base, id: requestId },
    { ...base, kind: "other" },
    { ...base, sourceSessionId: "bad" },
    { ...base, workspaceKey: "" },
  ]) {
    expect(() => runtime.attach(malformed as never)).toThrow(TypeError);
  }
});

test("notifications never make committed storage depend on local observers", () => {
  let observed: object | undefined;
  const event = { id: deliveryId, kind: "message" as const, state: "failed" as const };
  expect(() =>
    notifyContextAdmissionSafely(
      {
        notifyContextSettled(value) {
          observed = value;
          throw new Error("hostile observer");
        },
      },
      event,
    ),
  ).not.toThrow();
  expect(observed).toEqual(event);
  expect(observed).not.toBe(event);
  expect(Object.isFrozen(observed)).toBe(true);
});
