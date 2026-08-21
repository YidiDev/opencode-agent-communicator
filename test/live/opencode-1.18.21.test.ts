import { expect, setDefaultTimeout, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupAll } from "./harness/cleanup";
import { resolveExactProjectCli } from "./harness/cli";
import {
  diagnosticToolID,
  disposalDeadlineMs,
  exactOpenCodeVersion,
  liveDeadlineMs,
  testModelID,
  testProviderID,
} from "./harness/constants";
import { readEvidence, waitForEvidence } from "./harness/evidence";
import { directoryPath, requestJson } from "./harness/http";
import type { IsolatedOpenCodeState } from "./harness/isolation";
import { createIsolatedOpenCodeState } from "./harness/isolation";
import {
  launchManagedProcess,
  type ManagedProcess,
  runBoundedProcess,
  waitForOutputLine,
} from "./harness/process";
import { launchDeterministicProvider } from "./harness/provider";

setDefaultTimeout(liveDeadlineMs * 5);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

async function runExport(input: {
  readonly cliPath: string;
  readonly isolation: IsolatedOpenCodeState;
  readonly sessionID: string;
  readonly isSanitized: boolean;
}): Promise<Record<string, unknown>> {
  const result = await runBoundedProcess({
    command: input.cliPath,
    arguments: ["export", input.sessionID, ...(input.isSanitized ? ["--sanitize"] : [])],
    cwd: input.isolation.project,
    environment: input.isolation.environment,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe(`Exporting session: ${input.sessionID}\n`);
  const value: unknown = JSON.parse(result.stdout);
  return record(value, "CLI export");
}

test("validates the isolated exact OpenCode 1.18.21 live surface", async () => {
  const thisDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(thisDirectory, "..", "..");
  const pluginPath = await realpath(join(thisDirectory, "fixtures", "diagnostic-plugin.ts"));
  const provider = launchDeterministicProvider();
  let isolation: IsolatedOpenCodeState | undefined;
  let serve: ManagedProcess | undefined;
  let testFailure: unknown;

  try {
    const cliPath = await resolveExactProjectCli(projectRoot);
    isolation = await createIsolatedOpenCodeState({
      providerBaseUrl: provider.baseUrl,
      pluginPath,
    });
    expect(cliPath).toContain(join("node_modules", "opencode-ai", "bin"));
    const version = await runBoundedProcess({
      command: cliPath,
      arguments: ["--version"],
      cwd: isolation.project,
      environment: isolation.environment,
    });
    expect(version).toEqual({ exitCode: 0, stdout: `${exactOpenCodeVersion}\n`, stderr: "" });
    expect(isolation.environment.OPENCODE_PURE).toBeUndefined();

    serve = launchManagedProcess({
      command: cliPath,
      arguments: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: isolation.project,
      environment: isolation.environment,
    });
    const reportedUrl = await waitForOutputLine(serve.child, (line) => {
      const match = line.match(/^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)$/);
      return match?.[1];
    });
    const serverBaseUrl = `${reportedUrl}/`;
    expect(await requestJson(serverBaseUrl, "/global/health")).toEqual({
      healthy: true,
      version: exactOpenCodeVersion,
    });

    const project = record(
      await requestJson(serverBaseUrl, directoryPath("/project/git/init", isolation.project), {
        method: "POST",
      }),
      "initialized project",
    );
    expect(project.worktree).toBe(isolation.project);
    const tools = await requestJson(
      serverBaseUrl,
      directoryPath("/experimental/tool/ids", isolation.project),
    );
    expect(array(tools, "tool IDs")).toContain(diagnosticToolID);
    const initialized = await waitForEvidence(
      isolation.evidencePath,
      (item) =>
        item.event === "initialized" &&
        item.pid === serve?.child.pid &&
        item.worktree === isolation?.project,
    );
    expect(initialized.directory).toBe(isolation.project);
    expect(initialized.worktree).toBe(isolation.project);

    const session = record(
      await requestJson(serverBaseUrl, directoryPath("/session", isolation.project), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Live harness sensitive title" }),
      }),
      "session",
    );
    if (typeof session.id !== "string") throw new Error("session ID is absent");
    const sessionID = session.id;
    const response = record(
      await requestJson(
        serverBaseUrl,
        directoryPath(`/session/${encodeURIComponent(sessionID)}/message`, isolation.project),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerID: testProviderID, modelID: testModelID },
            agent: "build",
            tools: { [diagnosticToolID]: true },
            parts: [{ type: "text", text: `Invoke ${diagnosticToolID} exactly once.` }],
          }),
        },
      ),
      "prompt response",
    );
    expect(array(response.parts, "assistant parts").length).toBeGreaterThan(0);
    expect(provider.requests.length).toBe(2);

    const executed = await waitForEvidence(
      isolation.evidencePath,
      (item) => item.event === "executed" && item.pid === serve?.child.pid,
    );
    expect(executed.sessionID).toBe(sessionID);
    expect(typeof executed.messageID).toBe("string");
    expect(executed.agent).toBe("build");
    expect(executed.directory).toBe(isolation.project);
    expect(executed.worktree).toBe(isolation.project);
    expect(executed.abortSignalPresent).toBe(true);
    expect(executed.metadataAvailable).toBe(true);
    expect(executed.askAvailable).toBe(true);
    if (typeof executed.instanceID !== "number") throw new Error("plugin instance ID is absent");

    const unsanitized = await runExport({ cliPath, isolation, sessionID, isSanitized: false });
    const sanitized = await runExport({ cliPath, isolation, sessionID, isSanitized: true });
    expect(Object.keys(unsanitized).sort()).toEqual(["info", "messages"]);
    expect(Object.keys(sanitized).sort()).toEqual(["info", "messages"]);
    const rawInfo = record(unsanitized.info, "unsanitized info");
    const safeInfo = record(sanitized.info, "sanitized info");
    expect(rawInfo.id).toBe(sessionID);
    expect(safeInfo.id).toBe(sessionID);
    expect(rawInfo.title).toBe("Live harness sensitive title");
    expect(safeInfo.title).not.toBe(rawInfo.title);
    expect(safeInfo.directory).not.toBe(rawInfo.directory);
    expect(array(unsanitized.messages, "unsanitized messages").length).toBeGreaterThan(0);
    expect(array(sanitized.messages, "sanitized messages").length).toBe(
      array(unsanitized.messages, "unsanitized messages").length,
    );

    const serverPID = serve.child.pid;
    if (serverPID === undefined) throw new Error("server process ID is absent");
    expect(
      await requestJson(serverBaseUrl, directoryPath("/instance/dispose", isolation.project), {
        method: "POST",
      }),
    ).toBe(true);
    let disposed: Awaited<ReturnType<typeof waitForEvidence>>;
    try {
      disposed = await waitForEvidence(
        isolation.evidencePath,
        (item) =>
          item.event === "disposed" &&
          item.pid === serverPID &&
          item.instanceID === executed.instanceID,
        disposalDeadlineMs,
      );
    } catch (error: unknown) {
      const events = (await readEvidence(isolation.evidencePath)).map((item) => ({
        event: item.event,
        instanceID: item.instanceID,
        pid: item.pid,
      }));
      const message = error instanceof Error ? error.message : "unknown disposal error";
      throw new Error(`${message}; observed evidence: ${JSON.stringify(events)}`);
    }
    expect(disposed.pid).toBe(serverPID);
    expect(
      (await readEvidence(isolation.evidencePath)).some((item) => item.event === "executed"),
    ).toBe(true);
  } catch (error: unknown) {
    testFailure = error;
  } finally {
    await cleanupAll(
      [() => serve?.terminate(), () => provider.stop(), () => isolation?.remove()],
      testFailure,
    );
  }
});
