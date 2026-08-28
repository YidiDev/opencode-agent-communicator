import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { cleanupAll } from "./harness/cleanup";
import { resolveExactProjectCli } from "./harness/cli";
import {
  exactOpenCodeVersion,
  liveDeadlineMs,
  testModelID,
  testProviderID,
} from "./harness/constants";
import { requestJson } from "./harness/http";
import type { IsolatedOpenCodeState } from "./harness/isolation";
import { createIsolatedOpenCodeState } from "./harness/isolation";
import {
  launchManagedProcess,
  type ManagedProcess,
  runBoundedProcess,
  waitForOutputLine,
} from "./harness/process";
import {
  launchDeterministicProvider,
  type ProviderHarness,
  type ProviderRequestGate,
} from "./harness/provider";

setDefaultTimeout(liveDeadlineMs * 8);

type Client = ReturnType<typeof createOpencodeClient>;

interface PackedFixture {
  readonly client: Client;
  readonly entryPath: string;
  readonly isolation: IsolatedOpenCodeState;
  readonly provider: ProviderHarness;
  close(initialFailure?: unknown): Promise<void>;
}

interface Invocation {
  readonly sessionID: string;
  output(): Promise<Record<string, unknown>>;
}

interface Invoker {
  begin(id: string, marker: string, existingSessionID?: string): Promise<Invocation>;
  invoke(id: string, marker: string, existingSessionID?: string): Promise<Record<string, unknown>>;
}

interface ActiveTarget {
  readonly gate: ProviderRequestGate;
  readonly id: string;
  complete(): Promise<void>;
}

const toolIds = [
  "session_list",
  "session_send",
  "session_delivery_get",
  "session_ask",
  "session_respond",
  "session_wait",
  "session_signal",
  "session_request_list",
  "session_request_get",
  "session_request_ack",
  "session_request_cancel",
  "session_stop",
  "session_start",
  "session_export",
] as const;

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

async function installPackedPlugin(repository: string, staging: string): Promise<string> {
  const packed = Bun.spawnSync({
    cmd: ["npm", "pack", "--json", "--pack-destination", staging],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) throw new Error(`npm pack failed: ${packed.stderr.toString()}`);
  const report = JSON.parse(packed.stdout.toString()) as Array<{ filename?: string }>;
  const archive = join(staging, report[0]?.filename ?? "missing.tgz");
  const consumer = join(staging, "consumer");
  await mkdir(consumer);
  await Bun.write(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { "opencode-agent-communicator": archive } })}\n`,
  );
  const installed = Bun.spawnSync({
    cmd: [process.execPath, "install", "--ignore-scripts"],
    cwd: consumer,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (installed.exitCode !== 0) {
    throw new Error(`packed install failed: ${installed.stderr.toString()}`);
  }
  return realpath(join(consumer, "node_modules/opencode-agent-communicator/src/index.ts"));
}

function toolPart(messages: readonly { readonly parts: readonly unknown[] }[], id: string) {
  return messages
    .flatMap((message) => message.parts)
    .reverse()
    .find(
      (value): value is { tool: string; state: { status: string; output?: string } } =>
        typeof value === "object" && value !== null && Reflect.get(value, "tool") === id,
    );
}

function toolOutput(messages: readonly { readonly parts: readonly unknown[] }[], id: string) {
  const part = toolPart(messages, id);
  if (part?.state.status !== "completed" || typeof part.state.output !== "string") {
    throw new Error(`${id} did not complete: ${JSON.stringify(part)}`);
  }
  return JSON.parse(part.state.output) as Record<string, unknown>;
}

function requestID(value: unknown): string | undefined {
  return JSON.stringify(value).match(/req_[a-z0-9]{32}/)?.[0];
}

async function waitForTargetRequest(
  client: Client,
  sessionID: string,
  label: string,
): Promise<string> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const history = successful(
      await client.v2.session.history({ sessionID, limit: 100 }),
      `${label} target durable history`,
    ).data;
    const id = requestID(history);
    if (id) return id;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${label} request was not admitted to target ${sessionID}`);
}

async function waitForActiveTarget(
  client: Client,
  sessionID: string,
  label: string,
): Promise<void> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const status = successful(await client.session.status(), `${label} target status`)[sessionID];
    if (status?.type === "busy" || status?.type === "retry") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${label} target ${sessionID} did not become active`);
}

async function assertPinnedCli(cliPath: string, isolation: IsolatedOpenCodeState): Promise<void> {
  expect(
    await runBoundedProcess({
      command: cliPath,
      arguments: ["--version"],
      cwd: isolation.project,
      environment: isolation.environment,
    }),
  ).toEqual({ exitCode: 0, stdout: `${exactOpenCodeVersion}\n`, stderr: "" });
}

async function startPackedServer(
  cliPath: string,
  isolation: IsolatedOpenCodeState,
): Promise<{ readonly baseUrl: string; readonly client: Client; readonly serve: ManagedProcess }> {
  const serve = launchManagedProcess({
    command: cliPath,
    arguments: [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
      "--print-logs",
      "--log-level",
      "DEBUG",
    ],
    cwd: isolation.project,
    environment: isolation.environment,
  });
  const baseUrl = await waitForOutputLine(
    serve.child,
    (line) => line.match(/^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)$/)?.[1],
  );
  return {
    baseUrl,
    serve,
    client: createOpencodeClient({ baseUrl, directory: isolation.project }),
  };
}

async function initializeLiveProject(client: Client, baseUrl: string, directory: string) {
  expect(await requestJson(`${baseUrl}/`, "/global/health")).toEqual({
    healthy: true,
    version: exactOpenCodeVersion,
  });
  successful(await client.project.initGit({ directory }), "project init");
}

async function launchPackedFixture(): Promise<PackedFixture> {
  const repository = resolve(import.meta.dir, "../..");
  const staging = await mkdtemp(join(tmpdir(), "communicator-packed-live-"));
  const provider = launchDeterministicProvider({ gateText: "production-target-active" });
  let isolation: IsolatedOpenCodeState | undefined;
  let serve: ManagedProcess | undefined;
  try {
    const entryPath = await installPackedPlugin(repository, staging);
    expect(entryPath).toContain("node_modules/opencode-agent-communicator/src/index.ts");
    isolation = await createIsolatedOpenCodeState({
      providerBaseUrl: provider.baseUrl,
      pluginPath: entryPath,
      pluginOptions: { stateDirectory: join(staging, "production-state") },
    });
    const cliPath = await resolveExactProjectCli(repository);
    await assertPinnedCli(cliPath, isolation);
    const running = await startPackedServer(cliPath, isolation);
    serve = running.serve;
    await initializeLiveProject(running.client, running.baseUrl, isolation.project);
    const state = isolation;
    const activeServe = serve;
    return {
      client: running.client,
      entryPath,
      isolation: state,
      provider,
      async close(initialFailure?: unknown): Promise<void> {
        await cleanupAll(
          [
            () => activeServe.terminate(),
            () => provider.stop(),
            () => state.remove(),
            () => rm(staging, { recursive: true, force: true }),
          ],
          initialFailure,
        );
      },
    };
  } catch (error: unknown) {
    await cleanupAll(
      [
        () => serve?.terminate(),
        () => provider.stop(),
        () => isolation?.remove(),
        () => rm(staging, { recursive: true, force: true }),
      ],
      error,
    );
    throw new Error("unreachable packed fixture cleanup");
  }
}

async function assertPackedRegistration(fixture: PackedFixture): Promise<void> {
  const { client, entryPath, isolation } = fixture;
  const registered = successful(
    await client.tool.ids({ directory: isolation.project }),
    "tool IDs",
  );
  if (!registered.some((id) => id.startsWith("session_"))) {
    throw new Error("packed production tools were absent");
  }
  expect(registered.filter((id) => id.startsWith("session_")).sort()).toEqual([...toolIds].sort());
  const loadedConfig = successful(
    await client.config.get({ directory: isolation.project }),
    "loaded config",
  );
  const packedRoot = dirname(dirname(entryPath));
  expect(loadedConfig.skills?.paths).toContain(join(packedRoot, "skills"));
  const skills = successful(await client.app.skills({ directory: isolation.project }), "skills");
  expect(skills.map((skill) => skill.name)).toContain("session-orchestrator");
  expect(skills.map((skill) => skill.name)).toContain("session-worker");
}

function createInvoker(client: Client): Invoker {
  const begin = async (id: string, marker: string, existingSessionID?: string) => {
    const sessionID =
      existingSessionID ??
      successful(await client.session.create({ title: `Packed ${id}` }), `${id} caller`).id;
    const run = client.session.prompt({
      sessionID,
      model: { providerID: testProviderID, modelID: testModelID },
      agent: "build",
      tools: { [id]: true },
      parts: [{ type: "text", text: marker }],
    });
    return {
      sessionID,
      async output(): Promise<Record<string, unknown>> {
        successful(await run, `${id} prompt`);
        return toolOutput(
          successful(await client.session.messages({ sessionID }), `${id} messages`),
          id,
        );
      },
    };
  };
  return {
    begin,
    async invoke(id, marker, existingSessionID) {
      return (await begin(id, marker, existingSessionID)).output();
    },
  };
}

async function activateTarget(fixture: PackedFixture, label: string): Promise<ActiveTarget> {
  const active = successful(
    await fixture.client.session.create({ title: `Packed active ${label}` }),
    `${label} active target`,
  );
  const marker = `production-target-active-${label}`;
  const run = fixture.client.session.prompt({
    sessionID: active.id,
    model: { providerID: testProviderID, modelID: testModelID },
    agent: "build",
    parts: [{ type: "text", text: marker }],
  });
  const gate = await fixture.provider.waitForText(marker);
  await waitForActiveTarget(fixture.client, active.id, label);
  return {
    gate,
    id: active.id,
    async complete(): Promise<void> {
      successful(await run, `${label} target run`);
    },
  };
}

async function processTargetRequest(
  invoker: Invoker,
  target: ActiveTarget,
  requestId: string,
  label: "ask" | "wait",
): Promise<Record<string, unknown>> {
  target.gate.release(`${label} request admitted; process target`);
  await withinLiveDeadline(target.complete(), `${label} target activation completion`);
  const startedAt = Date.now();
  const toolID = label === "ask" ? "session_respond" : "session_signal";
  const output = await withinLiveDeadline(
    invoker.invoke(
      toolID,
      `production-session-${label === "ask" ? "respond" : "signal"}:${requestId}`,
      target.id,
    ),
    `${label} target processing`,
  );
  expect(Date.now() - startedAt).toBeLessThan(15_000);
  return output;
}

async function runBasicPackedJourneys(invoker: Invoker, targetSessionID: string): Promise<void> {
  expect(await invoker.invoke("session_list", "production-session-list")).toMatchObject({
    ok: true,
  });
  const sent = await invoker.invoke("session_send", `production-session-send:${targetSessionID}`);
  expect(sent).toMatchObject({ ok: true });
  const deliveryID = Reflect.get(Reflect.get(sent, "value") ?? {}, "delivery_id");
  if (typeof deliveryID !== "string") throw new Error("packed send returned no delivery ID");
  expect(
    await invoker.invoke(
      "session_delivery_get",
      `production-delivery-get:${deliveryID}`,
      targetSessionID,
    ),
  ).toMatchObject({ ok: true });
  expect(await invoker.invoke("session_request_list", "production-request-list")).toMatchObject({
    ok: true,
  });
  expect(await invoker.invoke("session_export", "production-export-unavailable")).toMatchObject({
    ok: false,
    error: { code: "export_unavailable" },
  });
}

async function runAskJourney(fixture: PackedFixture, invoker: Invoker): Promise<void> {
  const target = await activateTarget(fixture, "ask");
  const ask = await invoker.begin("session_ask", `production-session-ask:${target.id}`);
  const id = await waitForTargetRequest(fixture.client, target.id, "ask");
  const respondOutput = await processTargetRequest(invoker, target, id, "ask");
  const askOutput = await withinLiveDeadline(ask.output(), "ask/respond completion");
  expect(askOutput).toEqual({
    ok: true,
    value: { request_id: id, state: "answered", answers: [["yes"]] },
  });
  expect(respondOutput).toMatchObject({ ok: true, value: { request_id: id, state: "answered" } });
  expect(
    await invoker.invoke("session_request_get", `production-request-get:${id}`, ask.sessionID),
  ).toMatchObject({
    ok: true,
    value: {
      outcome: "available_result",
      metadata: { request_id: id, role: "source", result_state: "available" },
      result: { kind: "ask", answers: [["yes"]] },
    },
  });
  expect(
    await invoker.invoke("session_request_ack", `production-request-ack:${id}`, ask.sessionID),
  ).toMatchObject({ ok: true, value: { request_id: id, state: "acknowledged" } });
}

async function runWaitJourney(fixture: PackedFixture, invoker: Invoker): Promise<void> {
  const target = await activateTarget(fixture, "wait");
  const wait = await invoker.begin(
    "session_wait",
    `production-session-wait:${target.id}:production-signal`,
  );
  const id = await waitForTargetRequest(fixture.client, target.id, "wait");
  const signalOutput = await processTargetRequest(invoker, target, id, "wait");
  const waitOutput = await withinLiveDeadline(wait.output(), "wait/signal completion");
  expect(waitOutput).toEqual({
    ok: true,
    value: { request_id: id, state: "reached", evidence: "artifact://packed-live" },
  });
  expect(signalOutput).toMatchObject({ ok: true, value: { request_id: id, state: "reached" } });
  expect(
    await invoker.invoke("session_request_cancel", `production-request-cancel:${id}`, target.id),
  ).toMatchObject({ ok: false, error: { code: "not_found_or_unauthorized" } });
}

async function runStartStopJourney(invoker: Invoker, stopTargetSessionID: string): Promise<void> {
  const start = await invoker.begin("session_start", "production-session-start");
  const started = await withinLiveDeadline(start.output(), "session_start completion");
  if (started.ok === true) {
    expect(started).toMatchObject({
      value: {
        source_session_id: start.sessionID,
        idempotency_key: "packed-live-start",
        creation_state: "created",
        title_state: "updated",
        admission_state: "admitted",
      },
    });
  } else {
    expect(started).toMatchObject({
      ok: false,
      error: {
        code: "native_outcome_unknown",
        retryable: false,
        details: {
          operation: {
            source_session_id: start.sessionID,
            idempotency_key: "packed-live-start",
            creation_state: "outcome_unknown",
          },
        },
      },
    });
    const operation = Reflect.get(
      Reflect.get(Reflect.get(started, "error") ?? {}, "details") ?? {},
      "operation",
    );
    expect(typeof Reflect.get(operation ?? {}, "session_id")).toBe("string");
  }
  const stop = await invoker.begin(
    "session_stop",
    `production-session-stop:${stopTargetSessionID}`,
  );
  const stopped = await withinLiveDeadline(stop.output(), "session_stop completion");
  if (stopped.ok === true) {
    expect(stopped).toMatchObject({
      value: {
        session_id: stopTargetSessionID,
        communicator_state: { outcome: "applied", target_stopped: 0 },
      },
    });
  } else {
    expect(stopped).toMatchObject({
      ok: false,
      error: {
        code: "native_outcome_unknown",
        retryable: false,
        details: {
          communicator_state: { outcome: "applied", target_stopped: 0 },
        },
      },
    });
  }
}

test("runs the exact packed production plugin through OpenCode 1.18.23", async () => {
  const fixture = await launchPackedFixture();
  let failure: unknown;
  try {
    await assertPackedRegistration(fixture);
    const target = successful(
      await fixture.client.session.create({ title: "Packed target" }),
      "target",
    );
    const invoker = createInvoker(fixture.client);
    await runBasicPackedJourneys(invoker, target.id);
    await runStartStopJourney(invoker, target.id);
    await runAskJourney(fixture, invoker);
    await runWaitJourney(fixture, invoker);
    expect(successful(await fixture.client.instance.dispose(), "production plugin disposal")).toBe(
      true,
    );
  } catch (error: unknown) {
    failure = error;
  } finally {
    await fixture.close(failure);
  }
});
