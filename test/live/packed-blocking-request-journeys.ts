import { expect } from "bun:test";

import { liveDeadlineMs } from "./harness/constants";
import type { ProviderHarness, ProviderRequestGate } from "./harness/provider";

interface Invocation {
  readonly sessionID: string;
  output(): Promise<Record<string, unknown>>;
}

interface Invoker {
  begin(id: string, marker: string): Promise<Invocation>;
}

interface ActiveTarget {
  readonly gate: ProviderRequestGate;
  readonly id: string;
  complete(): Promise<void>;
}

interface PreparedTarget {
  readonly id: string;
  activate(): Promise<ActiveTarget>;
}

interface BlockingRequestFixture {
  readonly provider: ProviderHarness;
  prepareTarget(label: string): Promise<PreparedTarget>;
  readToolOutput(sessionId: string, toolId: string): Promise<Record<string, unknown>>;
  readToolState(sessionId: string, toolId: string): Promise<string | undefined>;
  withinLiveDeadline<Value>(promise: Promise<Value>, label: string): Promise<Value>;
}

async function waitForToolRunning(
  fixture: BlockingRequestFixture,
  sessionId: string,
  toolId: string,
): Promise<void> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const state = await fixture.readToolState(sessionId, toolId);
    if (state === "running") return;
    if (state === "error") throw new Error(`${toolId} failed before target release`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${toolId} did not start before the live deadline`);
}

async function runJourney(
  fixture: BlockingRequestFixture,
  invoker: Invoker,
  kind: "ask" | "wait",
): Promise<void> {
  const prepared = await fixture.prepareTarget(kind);
  const marker =
    kind === "ask"
      ? `production-session-ask:${prepared.id}`
      : `production-session-wait:${prepared.id}:production-signal`;
  const invocation = await invoker.begin(`session_${kind}`, marker);
  const sourceGate = await fixture.provider.waitForText(marker);
  const target = await prepared.activate();
  sourceGate.releaseTool(
    `session_${kind}`,
    kind === "ask"
      ? JSON.stringify({
          session_id: target.id,
          questions: [{ prompt: "Proceed?", options: ["yes"] }],
          timeout_seconds: 30,
        })
      : JSON.stringify({ session_id: target.id, milestone: "ready", timeout_seconds: 30 }),
  );
  const outputPromise = invocation.output();
  await waitForToolRunning(fixture, invocation.sessionID, `session_${kind}`);
  target.gate.releaseTool("live_context_hold");
  const completion = target.complete();
  let injected = await Promise.race([
    fixture.provider.waitForText(`production-target-active-${kind}`, target.gate.sequence),
    completion.then(() => {
      throw new Error(`${kind} target completed without a transformed follow-up request`);
    }),
  ]);
  let serialized = JSON.stringify(injected.body);
  for (let attempt = 0; !serialized.includes(`\\"operation\\":\\"${kind}\\"`); attempt += 1) {
    if (attempt >= 2) throw new Error(`${kind} context was absent after three target turns`);
    injected.releaseTool("live_context_hold");
    injected = await fixture.provider.waitForText(
      `production-target-active-${kind}`,
      injected.sequence,
    );
    serialized = JSON.stringify(injected.body);
  }
  expect(serialized).toContain(`\\"operation\\":\\"${kind}\\"`);
  const requestId = serialized.match(/\\"request_id\\":\\"(req_[a-z0-9]+)\\"/)?.[1];
  if (!requestId) throw new Error(`${kind} context contained no request ID`);
  injected.releaseTool(
    kind === "ask" ? "session_respond" : "session_signal",
    kind === "ask"
      ? JSON.stringify({ request_id: requestId, answers: [["yes"]] })
      : JSON.stringify({ request_id: requestId, evidence: "artifact://packed-live" }),
  );
  const output = await fixture.withinLiveDeadline(
    outputPromise,
    kind === "ask" ? "ask/respond completion" : "wait/signal completion",
  );
  await fixture.withinLiveDeadline(completion, `${kind} target activation completion`);
  expect(
    await fixture.readToolOutput(target.id, kind === "ask" ? "session_respond" : "session_signal"),
  ).toMatchObject({ ok: true });
  expect(output).toMatchObject(
    kind === "ask"
      ? { ok: true, value: { state: "answered", answers: [["yes"]] } }
      : { ok: true, value: { state: "reached", evidence: "artifact://packed-live" } },
  );
}

export async function runBlockingRequestJourneys(
  fixture: BlockingRequestFixture,
  invoker: Invoker,
): Promise<void> {
  await runJourney(fixture, invoker, "ask");
  await runJourney(fixture, invoker, "wait");
}
