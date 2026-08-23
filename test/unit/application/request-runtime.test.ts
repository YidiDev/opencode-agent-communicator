import { expect, test } from "bun:test";

import type { CommittedRequestTerminalEvent } from "../../../src/application/request-notification-port";
import {
  RequestRuntime,
  RequestRuntimeCapacityError,
  type RequestRuntimeOutcome,
  requestRuntimeMaximumWaitersHardCeiling,
} from "../../../src/application/request-runtime";
import { validateRequestId } from "../../../src/domain/generated-ids";

function id(seed: string) {
  const parsed = validateRequestId(`req_${seed.repeat(32)}`);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function event(requestId = id("1"), kind: "ask" | "wait" = "wait"): CommittedRequestTerminalEvent {
  return Object.freeze({
    requestId,
    kind,
    resolutionState: kind === "ask" ? "answered" : "reached",
    resolvedAtMs: 10,
    retainedResult:
      kind === "ask"
        ? Object.freeze({ kind, answers: Object.freeze([Object.freeze(["yes"])]) })
        : Object.freeze({ kind, evidence: "done" }),
  });
}

async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return !settled;
}

test("provisional and normal attachments observe committed terminal events", async () => {
  const runtime = new RequestRuntime();
  const provisional = runtime.attachProvisional({ requestId: id("1"), expectedKind: "wait" });
  const normal = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  const terminal = event();
  expect(runtime.notifyTerminal(terminal)).toBeUndefined();
  expect(await provisional.outcome).toEqual({ outcome: "terminal", event: terminal });
  expect(await normal.outcome).toEqual({ outcome: "terminal", event: terminal });
  provisional.detach();
  normal.detach();
});

test("notification before attachment is not cached and duplicate notification is harmless", async () => {
  const runtime = new RequestRuntime();
  runtime.notifyTerminal(event());
  const late = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  expect(await stillPending(late.outcome)).toBe(true);
  runtime.notifyTerminal(event());
  runtime.notifyTerminal(event());
  expect((await late.outcome).outcome).toBe("terminal");
});

test("kind mismatch wakes for reconciliation and malformed casts fail closed", async () => {
  const runtime = new RequestRuntime();
  const registration = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  runtime.notifyTerminal(event(id("1"), "ask"));
  expect(await registration.outcome).toEqual({ outcome: "reconcile" });
  const replacement = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  runtime.notifyTerminal({ requestId: id("1"), kind: "wait" } as CommittedRequestTerminalEvent);
  expect(await stillPending(replacement.outcome)).toBe(true);
  runtime.notifyTerminal(event());
  expect((await replacement.outcome).outcome).toBe("terminal");
});

test("detach is idempotent and an exact waiter bound is enforced", async () => {
  const runtime = new RequestRuntime(2);
  const first = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  const second = runtime.attach({ requestId: id("2"), expectedKind: "ask" });
  expect(() => runtime.attach({ requestId: id("3"), expectedKind: "wait" })).toThrow(
    RequestRuntimeCapacityError,
  );
  first.detach();
  first.detach();
  const replacement = runtime.attach({ requestId: id("3"), expectedKind: "wait" });
  runtime.stop("shutdown");
  expect(await second.outcome).toEqual({ outcome: "shutdown" });
  expect(await replacement.outcome).toEqual({ outcome: "shutdown" });
  expect(await stillPending(first.outcome)).toBe(true);
});

test("stop is idempotent, aborts effects, and preserves the first reason", async () => {
  const runtime = new RequestRuntime();
  const attached = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  expect(runtime.effectSignal.aborted).toBe(false);
  runtime.stop("ownership_lost");
  runtime.stop("shutdown");
  expect(runtime.effectSignal.aborted).toBe(true);
  expect(runtime.effectSignal.reason).toBe("ownership_lost");
  expect(await attached.outcome).toEqual({ outcome: "ownership_lost" });
  const stopped = runtime.attach({ requestId: id("2"), expectedKind: "ask" });
  expect(await stopped.outcome).toEqual({ outcome: "ownership_lost" });
  stopped.detach();
});

test("bounds, attachment values, and synchronous notification return are strict", () => {
  expect(() => new RequestRuntime(0)).toThrow(RangeError);
  expect(() => new RequestRuntime(requestRuntimeMaximumWaitersHardCeiling + 1)).toThrow(RangeError);
  const runtime = new RequestRuntime(1);
  expect(() =>
    runtime.attach({ requestId: "bad" as ReturnType<typeof id>, expectedKind: "wait" }),
  ).toThrow(TypeError);
  const registration = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  expect(registration.expectedKind).toBe("wait");
  const returned: undefined = runtime.notifyTerminal(event());
  expect(returned).toBeUndefined();
});

test("runtime outcome remains a closed discriminated union", () => {
  const consume = (outcome: RequestRuntimeOutcome): string => {
    if (outcome.outcome === "terminal") return outcome.event.resolutionState;
    return outcome.outcome;
  };
  expect(consume({ outcome: "shutdown" })).toBe("shutdown");
});

test("notifications reject hidden and symbol keys, then accept a fresh deeply frozen snapshot", async () => {
  const runtime = new RequestRuntime();
  const registration = runtime.attach({ requestId: id("1"), expectedKind: "ask" });
  const secret = Symbol("secret");
  const supplied = { ...event(id("1"), "ask") } as CommittedRequestTerminalEvent & {
    readonly [secret]?: string;
  };
  Object.defineProperty(supplied, secret, { value: "never forward" });
  Object.defineProperty(supplied, "hidden", { value: "never forward" });
  Object.freeze(supplied);
  runtime.notifyTerminal(supplied);
  expect(await stillPending(registration.outcome)).toBe(true);
  runtime.notifyTerminal(event(id("1"), "ask"));
  const outcome = await registration.outcome;
  expect(outcome.outcome).toBe("terminal");
  if (outcome.outcome !== "terminal") throw new Error("terminal fixture expected");
  expect(outcome.event).not.toBe(supplied);
  expect(Reflect.ownKeys(outcome.event)).toEqual([
    "requestId",
    "kind",
    "resolutionState",
    "resolvedAtMs",
    "retainedResult",
  ]);
  expect(Object.isFrozen(outcome.event)).toBe(true);
  expect(Object.isFrozen(outcome.event.retainedResult)).toBe(true);
  if (outcome.event.retainedResult?.kind === "ask") {
    expect(Object.isFrozen(outcome.event.retainedResult.answers)).toBe(true);
    expect(Object.isFrozen(outcome.event.retainedResult.answers[0])).toBe(true);
  }
});

test("excessive notification keys are rejected before descriptor work", async () => {
  const runtime = new RequestRuntime();
  const registration = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  let descriptorCalls = 0;
  const excessive = new Proxy(
    {},
    {
      ownKeys: () => ["one", "two", "three", "four", "five", "six"],
      getOwnPropertyDescriptor: () => {
        descriptorCalls += 1;
        return { configurable: true, enumerable: true, value: 1 };
      },
    },
  );
  runtime.notifyTerminal(excessive as CommittedRequestTerminalEvent);
  expect(descriptorCalls).toBe(0);
  expect(await stillPending(registration.outcome)).toBe(true);
  runtime.notifyTerminal(event());
  expect((await registration.outcome).outcome).toBe("terminal");
});

test("hostile notification objects never throw and malformed retained arrays do not settle", async () => {
  const runtime = new RequestRuntime();
  const registration = runtime.attach({ requestId: id("1"), expectedKind: "ask" });
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  expect(() =>
    runtime.notifyTerminal(revocable.proxy as CommittedRequestTerminalEvent),
  ).not.toThrow();
  const throwing = Object.freeze(
    Object.defineProperty({}, "requestId", {
      enumerable: true,
      get: () => {
        throw new Error("getter");
      },
    }),
  );
  expect(() => runtime.notifyTerminal(throwing as CommittedRequestTerminalEvent)).not.toThrow();
  const sparse = new Array<string[]>(2);
  sparse[1] = ["yes"];
  runtime.notifyTerminal(
    Object.freeze({
      requestId: id("1"),
      kind: "ask",
      resolutionState: "answered",
      resolvedAtMs: 10,
      retainedResult: Object.freeze({ kind: "ask", answers: Object.freeze(sparse) }),
    }),
  );
  for (const key of ["hidden", Symbol("hidden")]) {
    const answers = Object.defineProperty([["yes"]], key, { value: true });
    runtime.notifyTerminal({
      requestId: id("1"),
      kind: "ask",
      resolutionState: "answered",
      resolvedAtMs: 10,
      retainedResult: { kind: "ask", answers },
    });
  }
  expect(await stillPending(registration.outcome)).toBe(true);
  runtime.notifyTerminal(event(id("1"), "ask"));
  expect((await registration.outcome).outcome).toBe("terminal");
});

test("stop detaches waiters before reentrant abort listeners and ignores later notifications", async () => {
  const runtime = new RequestRuntime();
  const registration = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  runtime.effectSignal.addEventListener("abort", () => runtime.notifyTerminal(event()));
  runtime.stop("shutdown");
  runtime.notifyTerminal(event());
  expect(await registration.outcome).toEqual({ outcome: "shutdown" });
});

test("a committed cancellation is terminal data rather than a runtime shutdown", async () => {
  const runtime = new RequestRuntime();
  const registration = runtime.attach({ requestId: id("1"), expectedKind: "wait" });
  runtime.notifyTerminal(
    Object.freeze({
      requestId: id("1"),
      kind: "wait",
      resolutionState: "cancelled",
      resolvedAtMs: 10,
    }),
  );
  expect(await registration.outcome).toMatchObject({
    outcome: "terminal",
    event: { resolutionState: "cancelled" },
  });
  expect(runtime.effectSignal.aborted).toBe(false);
});
