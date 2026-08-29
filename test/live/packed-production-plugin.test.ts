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
import { runImmediateRequestJourneys } from "./packed-immediate-request-journeys";

setDefaultTimeout(liveDeadlineMs * 8);

type Client = ReturnType<typeof createOpencodeClient>;

interface PackedFixture {
  readonly cliPath: string;
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
  "session_lock_list",
  "session_lock_publish",
  "session_lock_release",
  "session_lock_renew",
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
  "session_request_send",
  "session_request_start",
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
    cmd: ["npm", "install", "--ignore-scripts"],
    cwd: consumer,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (installed.exitCode !== 0) {
    throw new Error(`npm packed install failed: ${installed.stderr.toString()}`);
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

async function waitForIdleTarget(client: Client, sessionID: string, label: string): Promise<void> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const status = successful(await client.session.status(), `${label} target status`)[sessionID];
    if (status === undefined || status.type === "idle") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${label} target ${sessionID} did not become idle`);
}

async function waitForPublicTranscript(
  client: Client,
  sessionID: string,
  expectedText: string,
): Promise<
  ReturnType<Client["session"]["messages"]> extends Promise<infer Result>
    ? NonNullable<Result extends { data?: infer Data } ? Data : never>
    : never
> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const transcript = successful(
      await client.session.messages({ sessionID }),
      "managed public transcript",
    );
    if (JSON.stringify(transcript).includes(expectedText)) return transcript as never;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`managed transcript did not contain ${JSON.stringify(expectedText)}`);
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
  const provider = launchDeterministicProvider({
    gateText: [
      "production-target-active",
      "Packed peer session ready check",
      "packed live delivery",
    ],
  });
  let isolation: IsolatedOpenCodeState | undefined;
  let serve: ManagedProcess | undefined;
  try {
    const entryPath = await installPackedPlugin(repository, staging);
    expect(entryPath).toContain("node_modules/opencode-agent-communicator/src/index.ts");
    isolation = await createIsolatedOpenCodeState({
      providerBaseUrl: provider.baseUrl,
      pluginPath: entryPath,
      pluginOptions: {
        stateDirectory: join(staging, "production-state"),
        policies: { start: "allow" },
      },
    });
    const cliPath = await resolveExactProjectCli(repository);
    await assertPinnedCli(cliPath, isolation);
    const running = await startPackedServer(cliPath, isolation);
    serve = running.serve;
    await initializeLiveProject(running.client, running.baseUrl, isolation.project);
    const state = isolation;
    const activeServe = serve;
    return {
      cliPath,
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
  expect(skills.map((skill) => skill.name).sort()).toEqual(
    expect.arrayContaining([
      "session-locks",
      "session-communication",
      "session-request-participant",
    ]),
  );
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

async function runBasicPackedJourneys(invoker: Invoker): Promise<void> {
  expect(await invoker.invoke("session_list", "production-session-list")).toMatchObject({
    ok: true,
  });
  expect(await invoker.invoke("session_request_list", "production-request-list")).toMatchObject({
    ok: true,
  });
  expect(await invoker.invoke("session_export", "production-export-unavailable")).toMatchObject({
    ok: false,
    error: { code: "export_unavailable" },
  });
}

async function runLockJourney(invoker: Invoker): Promise<void> {
  const published = await invoker.begin("session_lock_publish", "production-lock-publish");
  const publishOutput = await published.output();
  expect(publishOutput).toMatchObject({
    ok: true,
    value: {
      lock: {
        held_by_session_id: published.sessionID,
        title: "Packed release surface",
        description: "Exercise the packed advisory lock journey.",
        instructions: "Coordinate before touching packed acceptance files.",
      },
      notification: {
        eligible: expect.any(Number),
        admitted: expect.any(Number),
        unknown: expect.any(Number),
      },
    },
  });
  const lockID = Reflect.get(
    Reflect.get(Reflect.get(publishOutput, "value") ?? {}, "lock") ?? {},
    "lock_id",
  );
  if (typeof lockID !== "string") throw new Error("session_lock_publish returned no lock ID");

  expect(await invoker.invoke("session_lock_list", "production-lock-list")).toMatchObject({
    ok: true,
    value: { locks: [{ lock_id: lockID, held_by_session_id: published.sessionID }] },
  });
  expect(
    await invoker.invoke(
      "session_lock_renew",
      `production-lock-renew:${lockID}`,
      published.sessionID,
    ),
  ).toMatchObject({ ok: true, value: { lock: { lock_id: lockID } } });
  expect(
    await invoker.invoke(
      "session_lock_release",
      `production-lock-release:${lockID}`,
      published.sessionID,
    ),
  ).toMatchObject({ ok: true, value: { lock: { lock_id: lockID } } });
  expect(
    await invoker.invoke(
      "session_lock_list",
      "production-lock-list-after-release",
      published.sessionID,
    ),
  ).toMatchObject({ ok: true, value: { locks: [] } });
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

async function runStartStopJourney(
  fixture: PackedFixture,
  invoker: Invoker,
  stopTargetSessionID: string,
): Promise<void> {
  const start = await invoker.begin("session_start", "production-session-start");
  const initialGate = await fixture.provider.waitForText("Packed peer session ready check");
  const started = await withinLiveDeadline(start.output(), "session_start completion");
  expect(started).toMatchObject({
    ok: true,
    value: {
      source_session_id: start.sessionID,
      idempotency_key: "packed-live-start",
      creation_state: "created",
      admission_state: "admitted",
      title_state: "updated",
    },
  });
  const startedSessionID = Reflect.get(Reflect.get(started, "value") ?? {}, "session_id");
  if (typeof startedSessionID !== "string") throw new Error("session_start returned no session ID");
  expect(
    successful(
      await fixture.client.session.get({ sessionID: startedSessionID }),
      "created peer root",
    ),
  ).toMatchObject({
    id: startedSessionID,
    title: "Packed peer target",
  });
  const admittedTranscript = successful(
    await fixture.client.session.messages({ sessionID: startedSessionID }),
    "peer admitted public transcript",
  );
  expect(admittedTranscript.some((message) => message.info.role === "user")).toBe(true);
  expect(JSON.stringify(admittedTranscript)).toContain("Packed peer session ready check");
  initialGate.release("packed peer initial complete");
  const transcript = await waitForPublicTranscript(
    fixture.client,
    startedSessionID,
    "packed peer initial complete",
  );
  expect(transcript.some((message) => message.info.role === "user")).toBe(true);
  expect(transcript.some((message) => message.info.role === "assistant")).toBe(true);
  expect(JSON.stringify(transcript)).toContain("Packed peer session ready check");
  await waitForIdleTarget(fixture.client, startedSessionID, "peer initial");

  const send = await invoker.begin("session_send", `production-session-send:${startedSessionID}`);
  const sendGate = await fixture.provider.waitForText("packed live delivery", initialGate.sequence);
  const sent = await withinLiveDeadline(send.output(), "session_send completion");
  expect(sent).toMatchObject({
    ok: true,
    value: {
      source_session_id: send.sessionID,
      target_session_id: startedSessionID,
      state: "admitted",
      admission_evidence: { kind: "public_message", state: "admitted" },
    },
  });
  const deliveryID = Reflect.get(Reflect.get(sent, "value") ?? {}, "delivery_id");
  if (typeof deliveryID !== "string") throw new Error("packed send returned no delivery ID");
  expect(
    await invoker.invoke(
      "session_delivery_get",
      `production-delivery-get:${deliveryID}`,
      send.sessionID,
    ),
  ).toMatchObject({
    ok: true,
    value: { role: "source", delivery: { admission_evidence: { kind: "public_message" } } },
  });
  expect(
    JSON.stringify(
      successful(
        await fixture.client.session.messages({ sessionID: startedSessionID }),
        "peer sent public transcript",
      ),
    ),
  ).toContain("packed live delivery");
  sendGate.release("packed peer follow-up complete");
  await waitForPublicTranscript(fixture.client, startedSessionID, "packed peer follow-up complete");
  const exported = await runBoundedProcess({
    command: fixture.cliPath,
    arguments: ["export", startedSessionID],
    cwd: fixture.isolation.project,
    environment: fixture.isolation.environment,
  });
  expect(exported.exitCode).toBe(0);
  expect(exported.stderr).toBe(`Exporting session: ${startedSessionID}\n`);
  const exportDocument = JSON.parse(exported.stdout) as {
    readonly info?: { readonly id?: unknown; readonly title?: unknown };
    readonly messages?: readonly unknown[];
  };
  expect(exportDocument.info).toMatchObject({
    id: startedSessionID,
    title: "Packed peer target",
  });
  expect(exportDocument.messages?.length).toBeGreaterThanOrEqual(4);
  expect(exported.stdout).toContain("Packed peer session ready check");
  expect(exported.stdout).toContain("packed live delivery");
  expect(exported.stdout).toContain("packed peer follow-up complete");
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

test(`runs the exact packed production plugin through OpenCode ${exactOpenCodeVersion}`, async () => {
  const fixture = await launchPackedFixture();
  let failure: unknown;
  try {
    await assertPackedRegistration(fixture);
    const target = successful(
      await fixture.client.session.create({ title: "Packed target" }),
      "target",
    );
    const invoker = createInvoker(fixture.client);
    await runBasicPackedJourneys(invoker);
    await runLockJourney(invoker);
    await runStartStopJourney(fixture, invoker, target.id);
    await runAskJourney(fixture, invoker);
    await runWaitJourney(fixture, invoker);
    await runImmediateRequestJourneys(
      {
        async createSession(title, label) {
          return successful(await fixture.client.session.create({ title }), label).id;
        },
        async messages(sessionID, label) {
          return successful(await fixture.client.session.messages({ sessionID }), label);
        },
      },
      invoker,
    );
    expect(successful(await fixture.client.instance.dispose(), "production plugin disposal")).toBe(
      true,
    );
  } catch (error: unknown) {
    failure = error;
  } finally {
    await fixture.close(failure);
  }
});

test(`loads the packed production plugin during a direct OpenCode ${exactOpenCodeVersion} run`, async () => {
  const repository = resolve(import.meta.dir, "../..");
  const staging = await mkdtemp(join(tmpdir(), "communicator-packed-direct-run-"));
  const provider = launchDeterministicProvider();
  let isolation: IsolatedOpenCodeState | undefined;
  let failure: unknown;
  try {
    const entryPath = await installPackedPlugin(repository, staging);
    isolation = await createIsolatedOpenCodeState({
      providerBaseUrl: provider.baseUrl,
      pluginPath: entryPath,
      pluginOptions: { stateDirectory: join(staging, "direct-run-state") },
    });
    const cliPath = await resolveExactProjectCli(repository);
    const result = await runBoundedProcess({
      command: cliPath,
      arguments: [
        "run",
        "--agent",
        "build",
        "--format",
        "json",
        "--print-logs",
        "--log-level",
        "DEBUG",
        "production-session-list",
      ],
      cwd: isolation.project,
      environment: isolation.environment,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("failed to load plugin");
    expect(result.stderr).not.toContain("requires Linux x64 and a healthy OpenCode");
    const toolEvent = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown)
      .find(
        (event) =>
          Reflect.get(Reflect.get(event as object, "part") as object, "tool") === "session_list",
      );
    const toolState = Reflect.get(Reflect.get(toolEvent as object, "part") as object, "state");
    expect(Reflect.get(toolState as object, "status")).toBe("completed");
    const toolResult = JSON.parse(Reflect.get(toolState as object, "output") as string) as unknown;
    expect(toolResult).toMatchObject({ ok: true });
    expect(Reflect.get(toolResult as object, "value")).toBeArray();

    const advertised = provider.requests
      .map((request) => JSON.stringify(request))
      .find((request) => toolIds.every((toolID) => request.includes(`"name":"${toolID}"`)));
    expect(advertised).toBeDefined();
  } catch (error: unknown) {
    failure = error;
  } finally {
    await cleanupAll(
      [
        () => provider.stop(),
        () => isolation?.remove(),
        () => rm(staging, { recursive: true, force: true }),
      ],
      failure,
    );
  }
});
