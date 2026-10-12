import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

import { OpenCode } from "@opencode/client";
import { Effect } from "effect";

import {
  createOpenCode2NativeAdapter,
  type OpenCodeV2NativeContext,
} from "../../src/adapters/native/opencode-2";
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
