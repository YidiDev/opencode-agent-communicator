import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { runtimeDigest } from "../../tools/release-policy.mjs";
import { createIsolatedOpenCodeState, type IsolatedOpenCodeState } from "../live/harness/isolation";
import { runBoundedProcess } from "../live/harness/process";
import {
  assertContinuousObservation,
  SoakAssertion,
  type SoakObservation,
  soakHours,
  soakOutcome,
} from "./evidence";
import { hostMetrics, type SoakHost, startSoakHost } from "./host";
import { prepareFrozenRuntime, runSoakCompanions } from "./installation";
import { createSoakRoots, exerciseSoakHost } from "./journeys";
import { launchSoakProvider } from "./provider";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    artifact: { type: "string" },
    output: { type: "string" },
    smoke: { type: "boolean", default: false },
  },
});
if (!values.artifact || !values.output)
  throw new Error("Supply --artifact and a new --output directory");
const repository = resolve(import.meta.dir, "../..");
const output = resolve(values.output);
const smoke = values.smoke;
const requestedMs = smoke ? 180_000 : soakHours * 3_600_000;
const intervalMs = smoke ? 10_000 : 300_000;
const isolations: IsolatedOpenCodeState[] = [];
const hosts: SoakHost[] = [];
let provider: ReturnType<typeof launchSoakProvider> | undefined;
let phase = "initialization";
let elapsedMs = 0;
let samples = 0;
let restarts = 0;
let binding: Awaited<ReturnType<typeof prepareFrozenRuntime>> | undefined;
let startedAt: string | undefined;
let harnessCommit: string | undefined;
let sourceCommit: string | undefined;
let failureAssertion: string | undefined;
let completedOutcome: "passed" | "smoke_passed" | undefined;
let outputCreated = false;
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());

async function summary(result: string) {
  const record = {
    schema_version: 1,
    result,
    smoke,
    started_at: startedAt ?? null,
    updated_at: new Date().toISOString(),
    duration_hours: elapsedMs / 3_600_000,
    requested_hours: requestedMs / 3_600_000,
    samples,
    restarts,
    runtime_sha256: binding?.runtime_sha256 ?? null,
    archive_sha256: binding?.archive_sha256 ?? null,
    tag: binding?.tag ?? null,
    harness_commit: harnessCommit ?? null,
    source_commit: sourceCommit ?? null,
    bun: Bun.version,
    opencode: "2.1.3",
    phase,
    failure_assertion: failureAssertion ?? null,
    topology: {
      isolated_repositories: 2,
      roots_per_repository: 2,
      continuously_running_hosts: 1,
      restarted_hosts: 1,
    },
    provider_requests: provider?.requests() ?? 0,
    limitations: [
      "Local deterministic provider, not a paid-model or user-traffic trial",
      "OS clock unchanged; controlled clock regressions run separately",
      "Ownership contention/crash matrices are companion Docker tests, not continuous host fault injection",
      "No automatic stable-readiness approval",
    ],
  };
  await writeFile(join(output, "summary.tmp"), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(join(output, "summary.tmp"), join(output, "summary.json"));
}

async function initializeGit(isolation: IsolatedOpenCodeState) {
  const environment = { ...isolation.environment, GIT_CONFIG_NOSYSTEM: "1" };
  for (const arguments_ of [
    ["init", "--quiet"],
    [
      "-c",
      "user.name=Communicator Soak Fixture",
      "-c",
      "user.email=soak@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      `Synthetic isolated fixture ${crypto.randomUUID()}`,
    ],
  ]) {
    const result = await runBoundedProcess({
      command: "git",
      arguments: arguments_,
      cwd: isolation.project,
      environment,
    });
    if (result.exitCode !== 0) throw new Error("Isolated repository setup failed");
  }
}

async function bindRevisions(tag: string) {
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const revision = async (ref: string) => {
    const result = await runBoundedProcess({
      command: "git",
      arguments: ["rev-parse", "--verify", ref],
      cwd: repository,
      environment: gitEnvironment,
    });
    if (result.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout.trim()))
      throw new Error("Soak source revision unavailable");
    return result.stdout.trim();
  };
  harnessCommit = await revision("HEAD");
  sourceCommit = await revision(`${tag}^{commit}`);
  if (!smoke) {
    const status = await runBoundedProcess({
      command: "git",
      arguments: ["status", "--porcelain"],
      cwd: repository,
      environment: gitEnvironment,
    });
    if (status.exitCode !== 0 || status.stdout.trim())
      throw new Error("Full soak requires a clean committed harness");
  }
}

async function run() {
  await mkdir(output, { mode: 0o700 }); // Refuse to overwrite or resume earlier evidence.
  outputCreated = true;
  await writeFile(join(output, "events.jsonl"), "", { flag: "wx", mode: 0o600 });
  await summary("preparing");
  phase = "frozen_install";
  binding = await prepareFrozenRuntime(repository, resolve(values.artifact ?? ""), output);
  abort.signal.throwIfAborted();
  await bindRevisions(binding.tag);
  phase = "baseline_companions";
  await summary("preparing");
  await runSoakCompanions(repository, smoke);
  abort.signal.throwIfAborted();
  provider = launchSoakProvider();
  phase = "isolated_hosts";
  for (let index = 0; index < 2; index++) {
    const isolation = await createIsolatedOpenCodeState({
      providerBaseUrl: provider.baseUrl,
      pluginPath: join(binding.frozen, "src"),
    });
    isolations.push(isolation);
    await initializeGit(isolation);
    hosts.push(await startSoakHost(binding.frozen, isolation));
    abort.signal.throwIfAborted();
  }
  const roots = await Promise.all(hosts.map(createSoakRoots));
  const start = performance.now();
  startedAt = new Date().toISOString();
  let previous: SoakObservation = { elapsedMs: 0, wallMs: Date.now() };
  let nextFull = 0;
  phase = "observing";
  do {
    abort.signal.throwIfAborted();
    const observation = { elapsedMs: performance.now() - start, wallMs: Date.now() };
    assertContinuousObservation(previous, observation, intervalMs + 120_000);
    previous = observation;
    const full = observation.elapsedMs >= nextFull;
    if (full) nextFull = observation.elapsedMs + (smoke ? 60_000 : 3_600_000);
    await Promise.all(
      hosts.map(async (host, index) => {
        const pair = roots[index];
        if (!pair) throw new Error("Missing fixture roots");
        await exerciseSoakHost(host, pair, full);
      }),
    );
    const metrics = await Promise.all(hosts.map(hostMetrics));
    elapsedMs = performance.now() - start;
    const completedObservation = { elapsedMs, wallMs: Date.now() };
    assertContinuousObservation(previous, completedObservation, intervalMs + 120_000);
    previous = completedObservation;
    samples++;
    await appendFile(
      join(output, "events.jsonl"),
      `${JSON.stringify({
        elapsed_ms: elapsedMs,
        at: new Date().toISOString(),
        full_journeys: full,
        hosts: metrics,
      })}\n`,
    );
    await summary("running");
    if (restarts === 0 && elapsedMs >= requestedMs / 2) {
      phase = "planned_restart";
      const host = hosts[1];
      const isolation = isolations[1];
      if (!host || !isolation) throw new Error("Restart fixture missing");
      await host.managed.terminate();
      hosts[1] = await startSoakHost(binding.frozen, isolation);
      restarts++;
      await appendFile(
        join(output, "events.jsonl"),
        JSON.stringify({ event: "planned_host_restart", elapsed_ms: performance.now() - start }) +
          "\n",
      );
      phase = "observing";
    }
    if (elapsedMs < requestedMs)
      await delay(Math.min(intervalMs, requestedMs - elapsedMs), undefined, {
        signal: abort.signal,
      });
  } while (elapsedMs < requestedMs);
  // The last successful probe, not startup/sleep/companion time, ends the measured interval.
  if (
    (await runtimeDigest(binding.frozen)) !== binding.runtime_sha256 ||
    (await runtimeDigest(repository)) !== binding.runtime_sha256
  )
    throw new Error("Runtime changed during the observation interval");
  phase = "final_companions";
  await runSoakCompanions(repository, smoke);
  await Promise.all(hosts.map(hostMetrics));
  abort.signal.throwIfAborted();
  completedOutcome = soakOutcome({
    smoke,
    elapsedMs,
    requestedMs,
    samples,
    restarts,
    companionsPassed: true,
  });
}

try {
  await run();
} catch (failure) {
  // Never turn a crash, interrupted run, continuity gap, or shortened smoke into a pass.
  failureAssertion = failure instanceof SoakAssertion ? failure.step : undefined;
  if (outputCreated) {
    try {
      await summary("failed");
    } catch {
      /* An unavailable evidence destination is itself a failure. */
    }
  }
  console.error(
    JSON.stringify({
      result: "failed",
      phase,
      error_type: failure instanceof Error ? failure.name : "unknown",
      assertion: failure instanceof SoakAssertion ? failure.step : undefined,
    }),
  );
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled(hosts.map((host) => host.managed.terminate()));
  const hostsStopped = cleanup.every((result) => result.status === "fulfilled");
  const cleanupTail = await Promise.allSettled([
    provider?.stop(),
    ...(hostsStopped ? isolations.map((isolation) => isolation.remove()) : []),
  ]);
  if (
    abort.signal.aborted ||
    [...cleanup, ...cleanupTail].some((result) => result.status === "rejected")
  ) {
    process.exitCode = 1;
    completedOutcome = undefined;
    phase = "cleanup_or_interruption";
    if (outputCreated) await summary("failed");
  }
  if (completedOutcome && !abort.signal.aborted) {
    phase = "complete";
    await summary(completedOutcome);
    console.log(
      JSON.stringify({
        result: completedOutcome,
        duration_hours: elapsedMs / 3_600_000,
        samples,
        restarts,
      }),
    );
  }
}
