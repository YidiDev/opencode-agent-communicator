import { expect } from "bun:test";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { liveDeadlineMs, testModelID, testProviderID } from "./harness/constants";
import type { ProviderHarness } from "./harness/provider";

type Client = ReturnType<typeof createOpencodeClient>;

interface Invoker {
  invoke(id: string, marker: string, existingSessionID?: string): Promise<Record<string, unknown>>;
}

interface ContextRequestFixture {
  readonly client: Client;
  readonly provider: ProviderHarness;
  exportSession(sessionID: string): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

function successful<T>(
  result: { readonly data: T | undefined; readonly error?: unknown; readonly response: Response },
  label: string,
): NonNullable<T> {
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`${label} failed (${result.response.status}): ${JSON.stringify(result.error)}`);
  }
  return result.data as NonNullable<T>;
}

async function withinLiveDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), liveDeadlineMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForActiveTarget(client: Client, sessionID: string): Promise<void> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const status = successful(await client.session.status(), "request target status")[sessionID];
    if (status?.type === "busy" || status?.type === "retry") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`request target ${sessionID} did not become active`);
}

function toolOutput(messages: readonly { readonly parts: readonly unknown[] }[], id: string) {
  const part = messages
    .flatMap((message) => message.parts)
    .reverse()
    .find(
      (value): value is { tool: string; state: { status: string; output?: string } } =>
        typeof value === "object" && value !== null && Reflect.get(value, "tool") === id,
    );
  if (part?.state.status !== "completed" || typeof part.state.output !== "string") {
    throw new Error(`${id} did not complete: ${JSON.stringify(part)}`);
  }
  return JSON.parse(part.state.output) as Record<string, unknown>;
}

export async function runContextRequestJourney(
  fixture: ContextRequestFixture,
  invoker: Invoker,
): Promise<void> {
  const source = successful(
    await fixture.client.session.create({ title: "Packed context request source" }),
    "context request source",
  );
  const sourceRun = fixture.client.session.prompt({
    sessionID: source.id,
    model: { providerID: testProviderID, modelID: testModelID },
    agent: "build",
    tools: { session_request_send: true },
    parts: [{ type: "text", text: "production-context-request-source-gated" }],
  });
  const sourceGate = await fixture.provider.waitForText("production-context-request-source-gated");
  const target = successful(
    await fixture.client.session.create({ title: "Packed context request target" }),
    "context request target",
  );
  const marker = "production-target-active-context-request";
  const targetRun = fixture.client.session.prompt({
    sessionID: target.id,
    model: { providerID: testProviderID, modelID: testModelID },
    agent: "build",
    tools: { live_context_hold: true, session_signal: true },
    parts: [{ type: "text", text: marker }],
  });
  await waitForActiveTarget(fixture.client, target.id);
  const targetGate = await fixture.provider.waitForText(marker, sourceGate.sequence);
  sourceGate.releaseTool(
    "session_request_send",
    JSON.stringify({
      session_id: target.id,
      content: "packed private request context",
      request: {
        kind: "wait",
        milestone: "packed context request complete",
        timeout_seconds: 30,
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  targetGate.releaseTool("live_context_hold");

  const injected = await fixture.provider.waitForText(marker, targetGate.sequence);
  const providerBody = JSON.stringify(injected.body);
  expect(providerBody).toContain(`identity:${target.id}`);
  expect(providerBody).toContain("packed private request context");
  expect(providerBody).toContain('\\"operation\\":\\"wait\\"');
  expect(providerBody).toContain("live coexistence reminder");
  const requestID = providerBody.match(/\\"request_id\\":\\"(req_[a-z0-9]+)\\"/)?.[1];
  if (!requestID) throw new Error("injected request context contained no request ID");
  injected.releaseTool(
    "session_signal",
    JSON.stringify({ request_id: requestID, evidence: "artifact://packed-context-request" }),
  );
  successful(
    await withinLiveDeadline(targetRun, "context request target completion"),
    "context request target prompt",
  );
  successful(
    await withinLiveDeadline(sourceRun, "context request source completion"),
    "context request source prompt",
  );

  const sent = toolOutput(
    successful(
      await fixture.client.session.messages({ sessionID: source.id }),
      "context request source messages",
    ),
    "session_request_send",
  );
  expect(sent).toMatchObject({
    ok: true,
    value: {
      request_id: requestID,
      delivery_mode: "context",
      delivery_state: "context_admitted",
      resolution_state: "pending",
    },
  });
  expect(
    toolOutput(
      successful(
        await fixture.client.session.messages({ sessionID: target.id }),
        "context request target messages",
      ),
      "session_signal",
    ),
  ).toMatchObject({ ok: true, value: { request_id: requestID, state: "reached" } });
  expect(
    await invoker.invoke("session_request_get", `production-request-get:${requestID}`, source.id),
  ).toMatchObject({
    ok: true,
    value: {
      outcome: "available_result",
      metadata: { request_id: requestID, delivery_mode: "context", result_state: "available" },
      result: { kind: "wait", evidence: "artifact://packed-context-request" },
    },
  });
  const transcript = successful(
    await fixture.client.session.messages({ sessionID: target.id }),
    "context request target transcript",
  );
  expect(JSON.stringify(transcript)).not.toContain("packed private request context");
  const exported = await fixture.exportSession(target.id);
  expect(exported.exitCode).toBe(0);
  expect(exported.stdout).not.toContain("packed private request context");
}
