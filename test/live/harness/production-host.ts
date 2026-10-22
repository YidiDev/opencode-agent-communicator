import { resolve } from "node:path";
import type { JsonValue } from "@opencode/client";
import { OpenCode } from "@opencode/client";
import { cleanupAll } from "./cleanup";
import { resolveExactProjectCli } from "./cli";
import { liveDeadlineMs, liveServerPassword } from "./constants";
import { createIsolatedOpenCodeState, type IsolatedOpenCodeState } from "./isolation";
import { installPackedPlugin, type PackedPluginInstallation } from "./packed-plugin";
import { launchManagedProcess, type ManagedProcess, waitForOutputLine } from "./process";
import { launchDeterministicProvider, type ProviderHarness } from "./provider";

export async function launchPackedHost(
  options: {
    readonly fileEntrypoint?: boolean;
    readonly pluginOptions?: (root: string) => Readonly<Record<string, JsonValue>>;
  } = {},
) {
  const repository = resolve(import.meta.dir, "../../..");
  let installation: PackedPluginInstallation | undefined;
  let isolation: IsolatedOpenCodeState | undefined;
  let provider: ProviderHarness | undefined;
  let serve: ManagedProcess | undefined;
  const dispose = (failure?: unknown) =>
    cleanupAll(
      [
        () => serve?.terminate(),
        () => provider?.stop(),
        () => isolation?.remove(),
        () => installation?.remove(),
      ],
      failure,
    );
  try {
    installation = await installPackedPlugin(repository);
    provider = launchDeterministicProvider();
    isolation = await createIsolatedOpenCodeState({
      providerBaseUrl: provider.baseUrl,
      pluginPath: installation.packagePath + (options.fileEntrypoint ? "/index.ts" : ""),
      ...(options.pluginOptions ? { pluginOptions: options.pluginOptions } : {}),
    });
    serve = launchManagedProcess({
      command: await resolveExactProjectCli(repository),
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
    await client.location.get({ location: { directory: isolation.project } });
    const deadline = performance.now() + liveDeadlineMs;
    while (performance.now() < deadline) {
      const registry = await client.plugin.list({ location: { directory: isolation.project } });
      if (
        options.fileEntrypoint
          ? serve.stderr().includes("configured plugin path must be a directory")
          : registry.data.some((plugin) => plugin.id === "opencode-agent-communicator")
      )
        break;
      await Bun.sleep(25);
    }
    const registry = await client.plugin.list({ location: { directory: isolation.project } });
    if (
      !options.fileEntrypoint &&
      !registry.data.some((plugin) => plugin.id === "opencode-agent-communicator")
    ) {
      throw new Error(`Packed plugin did not register: ${serve.stderr()}`);
    }
    return { client, isolation, serve, dispose, packagePath: installation.packagePath };
  } catch (failure) {
    await dispose(failure);
    throw failure;
  }
}

export async function invokePackedTool(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  marker: string,
  name: string,
) {
  const previous = new Set(
    (await client.session.context({ sessionID })).map((message) => message.id),
  );
  await client.session.prompt({ sessionID, text: marker, delivery: "queue", resume: true });
  await client.session.wait({ sessionID });
  const messages = await client.session.context({ sessionID });
  const call = messages
    .filter((message) => !previous.has(message.id))
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
