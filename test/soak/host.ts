import { readdir, readFile } from "node:fs/promises";
import { OpenCode } from "@opencode/client";
import { communicatorToolIds } from "../../src/composition/tools";
import { resolveExactProjectCli } from "../live/harness/cli";
import type { IsolatedOpenCodeState } from "../live/harness/isolation";
import { launchManagedProcess, waitForOutputLine } from "../live/harness/process";
import { waitForPackedRegistration } from "../live/harness/production-host";
import { soakMarker } from "./provider";

export async function startSoakHost(frozen: string, isolation: IsolatedOpenCodeState) {
  const password = crypto.randomUUID() + crypto.randomUUID();
  const managed = launchManagedProcess({
    command: await resolveExactProjectCli(frozen),
    arguments: [
      "--print-logs",
      "--log-level",
      "warn",
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    cwd: isolation.project,
    environment: { ...isolation.environment, OPENCODE_PASSWORD: password },
  });
  try {
    const baseUrl = await waitForOutputLine(
      managed.child,
      (line) => line.match(/^server listening on (http:\/\/127\.0\.0\.1:\d+)$/)?.[1],
    );
    managed.child.stdout.resume();
    const client = OpenCode.make({
      baseUrl,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      },
    });
    await waitForPackedRegistration(client, isolation.project);
    const plugins = await client.plugin.list(
      { location: { directory: isolation.project } },
      { signal: AbortSignal.timeout(30_000) },
    );
    if (
      !plugins.data.some(
        (plugin) => plugin.id === "opencode-agent-communicator" && plugin.state.status === "active",
      )
    )
      throw new Error("Packed soak plugin is not active");
    return { client, managed, isolation };
  } catch (failure) {
    await managed.terminate();
    throw failure;
  }
}

export type SoakHost = Awaited<ReturnType<typeof startSoakHost>>;

export async function invokeSoakTool(
  host: SoakHost,
  sessionID: string,
  name: string,
  arguments_: Record<string, unknown> = {},
) {
  if (!communicatorToolIds.includes(name as (typeof communicatorToolIds)[number]))
    throw new Error("Invalid soak tool identity");
  const options = { signal: AbortSignal.timeout(30_000) };
  const previous = new Set(
    (await host.client.session.context({ sessionID }, options)).map((message) => message.id),
  );
  await host.client.session.prompt(
    {
      sessionID,
      text:
        soakMarker + JSON.stringify({ name, arguments: arguments_, nonce: crypto.randomUUID() }),
      delivery: "queue",
      resume: true,
    },
    options,
  );
  await host.client.session.wait({ sessionID }, options);
  const messages = await host.client.session.context({ sessionID }, options);
  const call = messages
    .filter((message) => !previous.has(message.id))
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .filter((part) => part.type === "tool" && part.name === name)
    .at(-1);
  if (call?.type !== "tool" || call.state.status !== "completed")
    throw new Error("Soak tool did not complete");
  const result = JSON.parse(
    call.state.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  ) as { ok: boolean; value?: Record<string, unknown>; error?: { code: string } };
  return { ...result, operation: name };
}

export async function hostMetrics(host: SoakHost) {
  if (host.managed.child.exitCode !== null || host.managed.child.signalCode !== null)
    throw new Error("Soak host exited unexpectedly");
  const pid = host.managed.child.pid;
  if (pid === undefined) throw new Error("Soak host PID unavailable");
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]);
  const descriptors = (await readdir(`/proc/${pid}/fd`)).length;
  if (!Number.isFinite(rssKiB) || rssKiB > 1_572_864 || descriptors > 4096)
    throw new Error("Soak host exceeded its resource ceiling");
  return { rss_kib: rssKiB, descriptors };
}
