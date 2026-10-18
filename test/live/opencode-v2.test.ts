import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

import { OpenCode } from "@opencode/client";
import { Effect } from "effect";

import {
  createOpenCode2NativeAdapter,
  type OpenCodeV2NativeContext,
} from "../../src/adapters/native/opencode-2";
import { communicatorToolIds } from "../../src/composition/tools";
import { validateWorkspaceKey } from "../../src/domain/workspaces";
import { cleanupAll } from "./harness/cleanup";
import { resolveExactProjectCli } from "./harness/cli";
import { exactOpenCodeVersion, liveDeadlineMs, liveServerPassword } from "./harness/constants";
import type { IsolatedOpenCodeState } from "./harness/isolation";
import { createIsolatedOpenCodeState } from "./harness/isolation";
import { installPackedPlugin, type PackedPluginInstallation } from "./harness/packed-plugin";
import {
  launchManagedProcess,
  type ManagedProcess,
  runBoundedProcess,
  waitForOutputLine,
} from "./harness/process";
import { launchDeterministicProvider, type ProviderHarness } from "./harness/provider";

setDefaultTimeout(liveDeadlineMs * 4);

async function invokeTool(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  marker: string,
  name: string,
) {
  await client.session.prompt({ sessionID, text: marker, delivery: "queue", resume: true });
  await client.session.wait({ sessionID });
  const messages = await client.session.context({ sessionID });
  const call = messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .filter((part) => part.type === "tool" && part.name === name)
    .at(-1);
  if (call?.type !== "tool" || call.state.status !== "completed")
    throw new Error(`${name} did not complete`);
  return JSON.parse(
    call.state.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  ) as {
    ok: boolean;
    value?: Record<string, unknown>;
    error?: { code: string };
  };
}

async function verifyPackedJourneys(client: ReturnType<typeof OpenCode.make>, sessionID: string) {
  const published = await invokeTool(
    client,
    sessionID,
    "production-lock-publish",
    "session_lock_publish",
  );
  expect(published).toMatchObject({ ok: true, value: { lock: { held_by_session_id: sessionID } } });
  const lock = published.value?.lock as { lock_id?: string } | undefined;
  if (!lock?.lock_id) throw new Error("missing lock identity");
  expect(
    await invokeTool(client, sessionID, "production-lock-list", "session_lock_list"),
  ).toMatchObject({ ok: true, value: { locks: [{ lock_id: lock.lock_id }] } });
  expect(
    await invokeTool(
      client,
      sessionID,
      `production-lock-renew:${lock.lock_id}`,
      "session_lock_renew",
    ),
  ).toMatchObject({ ok: true, value: { lock: { lock_id: lock.lock_id } } });
  expect(
    await invokeTool(
      client,
      sessionID,
      `production-lock-release:${lock.lock_id}`,
      "session_lock_release",
    ),
  ).toMatchObject({ ok: true });
  expect(
    await invokeTool(client, sessionID, "production-lock-list-after-release", "session_lock_list"),
  ).toMatchObject({ ok: true, value: { locks: [] } });
  expect(
    await invokeTool(
      client,
      sessionID,
      `production-session-read-self:${sessionID}`,
      "session_read",
    ),
  ).toMatchObject({ ok: true, value: { session_id: sessionID, is_live: false } });
  for (const [marker, name, code] of [
    [`production-context-send:${sessionID}`, "session_send", "target_status_unknown"],
    [`production-session-stop:${sessionID}`, "session_stop", "native_unavailable"],
    ["production-session-start", "session_start", "permission_denied"],
    ["production-export-unavailable", "session_export", "export_unavailable"],
  ] as const) {
    expect(await invokeTool(client, sessionID, marker, name)).toMatchObject({
      ok: false,
      error: { code },
    });
  }
}

async function verifyQueuedPeerJourney(client: ReturnType<typeof OpenCode.make>, sourceID: string) {
  const source = await client.session.get({ sessionID: sourceID });
  const target = await client.session.create({
    title: "Packed queue peer",
    agent: "build",
    model: { providerID: "live-test", id: "deterministic-model" },
    location: source.location,
  });
  const sent = await invokeTool(
    client,
    sourceID,
    `production-session-send:${target.id}`,
    "session_send",
  );
  expect(sent).toMatchObject({
    ok: true,
    value: { delivery: "user", state: "admitted", target_session_id: target.id },
  });
  const deliveryID = sent.value?.delivery_id;
  if (typeof deliveryID !== "string") throw new Error("missing delivery identity");
  expect(
    await invokeTool(
      client,
      sourceID,
      `production-delivery-get:${deliveryID}`,
      "session_delivery_get",
    ),
  ).toMatchObject({
    ok: true,
    value: { delivery: { delivery_id: deliveryID, target_session_id: target.id } },
  });
  await client.session.wait({ sessionID: target.id });
  const requested = await invokeTool(
    client,
    sourceID,
    `production-session-request-send-ask:${target.id}`,
    "session_request_send",
  );
  expect(requested).toMatchObject({
    ok: true,
    value: { target_session_id: target.id, kind: "ask", delivery_mode: "queue" },
  });
  const requestID = requested.value?.request_id;
  if (typeof requestID !== "string") throw new Error("missing request identity");
  await client.session.wait({ sessionID: target.id });
  expect(
    await invokeTool(
      client,
      target.id,
      `production-request-get:${requestID}`,
      "session_request_get",
    ),
  ).toMatchObject({
    ok: true,
    value: { outcome: "pending_payload", metadata: { request_id: requestID, role: "target" } },
  });
  expect(
    await invokeTool(
      client,
      target.id,
      `production-session-respond:${requestID}`,
      "session_respond",
    ),
  ).toMatchObject({ ok: true });
  expect(
    await invokeTool(
      client,
      sourceID,
      `production-request-get:${requestID}`,
      "session_request_get",
    ),
  ).toMatchObject({
    ok: true,
    value: {
      metadata: { request_id: requestID, resolution_state: "answered", result_state: "available" },
      result: { kind: "ask", answers: [["yes"]] },
    },
  });
  expect(
    await invokeTool(
      client,
      sourceID,
      `production-request-ack:${requestID}`,
      "session_request_ack",
    ),
  ).toMatchObject({ ok: true });
}

test("keeps unsupported public-v2 native observations fail-closed", async () => {
  const workspace = validateWorkspaceKey("workspace:live-v2");
  if (!workspace.ok) throw new Error("live workspace fixture is invalid");
  const unavailable = Effect.die("unexpected host operation");
  const context = {
    app: { version: exactOpenCodeVersion },
    session: {
      context: () => unavailable,
      create: () => unavailable,
      get: () => unavailable,
      interrupt: () => unavailable,
      prompt: () => unavailable,
      update: () => unavailable,
    },
  } as unknown as OpenCodeV2NativeContext;
  const adapter = createOpenCode2NativeAdapter({
    context,
    directory: "/workspace",
    workspaceKey: workspace.value,
    projectId: "project-live-v2",
  });

  expect(await adapter.readHealth()).toEqual({ healthy: true, version: exactOpenCodeVersion });
  expect(await adapter.readVisibleRoots(false)).toEqual([]);
  expect(
    await adapter.isEligibleContextTarget({
      workspaceKey: workspace.value,
      sessionId: "ses_01LIVEV20000000000000000002" as never,
      abort: new AbortController().signal,
    }),
  ).toBe(false);
  expect(
    await adapter.steerRequest({
      targetSessionId: "ses_01LIVEV20000000000000000001" as never,
      nativeMessageId: "msg_01LIVEV20000000000000000001" as never,
      envelope: "must not be admitted without a public v2 steering API",
      abort: new AbortController().signal,
    }),
  ).toEqual({ kind: "unknown" });
});

test(`loads the packed Effect plugin through public OpenCode ${exactOpenCodeVersion} APIs`, async () => {
  const repository = resolve(import.meta.dir, "../..");
  let installation: PackedPluginInstallation | undefined;
  let isolation: IsolatedOpenCodeState | undefined;
  let provider: ProviderHarness | undefined;
  let serve: ManagedProcess | undefined;
  let failure: unknown;
  try {
    installation = await installPackedPlugin(repository);
    provider = launchDeterministicProvider();
    isolation = await createIsolatedOpenCodeState({
      providerBaseUrl: provider.baseUrl,
      pluginPath: installation.packagePath,
    });
    const cliPath = await resolveExactProjectCli(repository);
    expect(cliPath).toContain("node_modules/@opencode/cli/bin");
    expect(
      await runBoundedProcess({
        command: cliPath,
        arguments: ["--version"],
        cwd: isolation.project,
        environment: isolation.environment,
      }),
    ).toEqual({ exitCode: 0, stdout: `opencode v${exactOpenCodeVersion}\n`, stderr: "" });

    serve = launchManagedProcess({
      command: cliPath,
      arguments: [
        "--print-logs",
        "--log-level",
        "debug",
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ],
      cwd: isolation.project,
      environment: isolation.environment,
    });
    const baseUrl = await waitForOutputLine(
      serve.child,
      (line) => line.match(/^server listening on (http:\/\/127\.0\.0\.1:\d+)$/)?.[1],
    );
    const client = OpenCode.make({
      baseUrl,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${liveServerPassword}`).toString("base64")}`,
      },
    });
    expect((await client.server.info()).version).toBe(exactOpenCodeVersion);
    expect(
      (await client.location.get({ location: { directory: isolation.project } })).directory,
    ).toBe(isolation.project);
    const configuration = await client.config.get({ location: { directory: isolation.project } });
    expect(configuration).toContainEqual(
      expect.objectContaining({
        type: "document",
        info: expect.objectContaining({ plugins: expect.any(Array) }),
      }),
    );

    let plugins = await client.plugin.list({ location: { directory: isolation.project } });
    const pluginDeadline = Date.now() + liveDeadlineMs;
    while (
      !plugins.data.some((plugin) => plugin.id === "opencode-agent-communicator") &&
      Date.now() < pluginDeadline
    ) {
      await Bun.sleep(50);
      plugins = await client.plugin.list({ location: { directory: isolation.project } });
    }
    const communicator = plugins.data.find(
      (plugin) => plugin.id === "opencode-agent-communicator" || plugin.source.type === "local",
    );
    if (communicator?.state.status === "failed") {
      throw new Error(
        `packed plugin failed to load: ${communicator.state.error}\n${serve.stderr()}`,
      );
    }
    expect(plugins.data).toContainEqual(
      expect.objectContaining({
        id: "opencode-agent-communicator",
        state: { status: "active" },
      }),
    );
    const skills = await client.skill.list({ location: { directory: isolation.project } });
    expect(
      skills.data
        .filter((skill) =>
          ["session-communication", "session-request-participant", "session-locks"].includes(
            skill.name,
          ),
        )
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(["session-communication", "session-locks", "session-request-participant"]);

    const session = await client.session.create({
      title: "OpenCode v2 public API compatibility",
      agent: "build",
      model: { providerID: "live-test", id: "deterministic-model" },
      location: { directory: isolation.project },
    });
    expect((await client.session.get({ sessionID: session.id })).id).toBe(session.id);
    await client.session.update({ sessionID: session.id, title: "OpenCode v2 updated title" });
    expect((await client.session.get({ sessionID: session.id })).title).toBe(
      "OpenCode v2 updated title",
    );
    await client.session.prompt({
      sessionID: session.id,
      text: "production-session-list",
      delivery: "queue",
      resume: true,
    });
    await client.session.wait({ sessionID: session.id });
    expect(
      provider.requests.some((request) =>
        JSON.stringify(request).includes('"name":"session_list"'),
      ),
    ).toBe(true);
    const advertised = provider.requests.flatMap((request) => {
      const body = request as { tools?: Array<{ function?: { name?: string } }> };
      return (
        body.tools
          ?.map((tool) => tool.function?.name)
          .filter((name) => name?.startsWith("session_")) ?? []
      );
    });
    expect([...new Set(advertised)].sort()).toEqual([...communicatorToolIds].sort());
    const context = await client.session.context({ sessionID: session.id });
    const calls = context
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .filter((part) => part.type === "tool" && part.name === "session_list");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool" || call.state.status !== "completed")
      throw new Error("session_list did not complete");
    const text = call.state.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      value: [{ session_id: session.id, status: "unknown" }],
    });
    await verifyPackedJourneys(client, session.id);
    await verifyQueuedPeerJourney(client, session.id);
    expect((await client.session.interrupt({ sessionID: session.id })).interrupted).toBeBoolean();
  } catch (error: unknown) {
    failure = error;
  } finally {
    await cleanupAll(
      [
        () => serve?.terminate(),
        () => provider?.stop(),
        () => isolation?.remove(),
        () => installation?.remove(),
      ],
      failure,
    );
  }
});
