import { Database } from "bun:sqlite";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { LinuxBunSqliteStore } from "../../../src/adapters/store/sqlite-store";
import { StoreSecurityError } from "../../../src/adapters/store/store-types";
import type { PrepareDeliveryInput } from "../../../src/application/delivery-ports";
import { recoverMessageDeliveries } from "../../../src/application/recover-message-deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import type { FencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const victimUid = 10_001;
const attackerUid = 10_002;
const databaseName = "communicator.sqlite3";
const driverPath = process.argv[1] ?? "test/acceptance/store/driver.ts";
const controlRoot = "/control";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`acceptance assertion failed: ${message}`);
}

function valid<Value>(value: { ok: true; value: Value } | { ok: false }): Value {
  if (!value.ok) throw new Error("invalid acceptance fixture");
  return value.value;
}

const workspace = valid(validateWorkspaceKey("workspace:docker-acceptance"));
const source = valid(validateSessionId("ses_acceptancesource"));
const target = valid(validateSessionId("ses_acceptancetarget"));

function fixture(token: FencingToken, index: number): PrepareDeliveryInput {
  const encoded = index.toString(16).padStart(32, "0");
  return {
    fencingToken: token,
    id: valid(validateDeliveryId(`dlv_${encoded}`)),
    workspaceKey: workspace,
    sourceSessionId: source,
    targetSessionId: target,
    nativeMessageId: valid(validateNativeMessageId(`msg_${encoded}`)),
    envelope: `{"payload":{"content":"acceptance-${index}"}}`,
    contentByteLength: 16,
    contentSha256: "c".repeat(64) as Sha256Digest,
    nowMs: Date.now(),
  };
}

function openStore(state: string, ownerId: string): LinuxBunSqliteStore {
  return new LinuxBunSqliteStore({
    stateDirectory: state,
    workspaceKey: workspace,
    ownerId,
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    busyTimeoutMs: 200,
    limits: { databaseBytes: 8 * 1024 * 1024 },
  });
}

function marker(name: string): string {
  return join(controlRoot, name);
}

async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(20);
  }
}

function resetPath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function stateModeEvidence(state: string, databasePath: string): void {
  assert((lstatSync(state).mode & 0o777) === 0o700, "state directory mode is 0700");
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    const value = lstatSync(path);
    assert((value.mode & 0o777) === 0o600, `${path} mode is 0600`);
    assert(value.nlink === 1, `${path} has exactly one link`);
    assert(value.uid === victimUid, `${path} belongs to victim UID`);
  }
}

function integrityEvidence(databasePath: string): void {
  const reader = new Database(databasePath, { readonly: true, strict: true });
  try {
    const quick = reader.query<Record<string, unknown>, []>("PRAGMA quick_check").get();
    assert(Object.values(quick ?? {})[0] === "ok", "quick_check is ok");
    assert(reader.query("PRAGMA foreign_key_check").all().length === 0, "foreign keys are intact");
  } finally {
    reader.close(true);
  }
}

function fileIdentity(path: string): { readonly inode: bigint; readonly hash: string } {
  const stat = lstatSync(path, { bigint: true });
  return {
    inode: stat.ino,
    hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function assertBroadModeRejectedWithoutMutation(
  state: string,
  expectedStateMode: number,
  expectedDatabaseMode: number,
  label: string,
): void {
  const paths = readdirSync(state).map((name) => join(state, name));
  const before = new Map(paths.map((path) => [path, fileIdentity(path)]));
  let rejected = false;
  try {
    openStore(state, `broad-mode-${label}`);
  } catch (cause: unknown) {
    rejected = cause instanceof StoreSecurityError;
  }
  assert(rejected, `${label} is rejected`);
  assert((lstatSync(state).mode & 0o777) === expectedStateMode, `${label} state mode is unchanged`);
  assert(readdirSync(state).length === paths.length, `${label} creates no state files`);
  for (const [path, identity] of before) {
    assert(fileIdentity(path).inode === identity.inode, `${label} inode is unchanged`);
    assert(fileIdentity(path).hash === identity.hash, `${label} content is unchanged`);
  }
  assert(
    (lstatSync(join(state, databaseName)).mode & 0o777) === expectedDatabaseMode,
    `${label} database mode is unchanged`,
  );
}

async function baselineWorker(root: string): Promise<void> {
  assert(process.getuid?.() === victimUid, "store worker is victim UID 10001");
  const state = join(root, "baseline-state");
  const store = openStore(state, "baseline");
  const token = await store.acquire();
  assert((await store.createPrepared(fixture(token, 1))).ok, "baseline write succeeds");
  const diagnostics = await store.readStorageDiagnostics();
  assert(diagnostics.journalMode === "wal", "WAL is active");
  stateModeEvidence(state, store.databasePath);
  integrityEvidence(store.databasePath);

  const ready = marker("lock-ready");
  const release = marker("lock-release");
  const blocker = spawn(process.execPath, [
    driverPath,
    "lock-holder",
    store.databasePath,
    ready,
    release,
  ]);
  await waitFor(ready);
  const started = performance.now();
  const blocked = await store.createPrepared(fixture(token, 2));
  const elapsed = performance.now() - started;
  assert(!blocked.ok && blocked.code === "storage_unavailable", "lock contention is classified");
  assert(elapsed >= 150 && elapsed < 2_000, `busy timeout is bounded (${elapsed.toFixed(0)}ms)`);
  writeFileSync(release, "release");
  assert((await waitChild(blocker)).code === 0, "lock holder exits cleanly");
  assert((await store.createPrepared(fixture(token, 3))).ok, "write recovers after lock release");
  store.close();

  integrityEvidence(join(state, databaseName));
  chmodSync(state, 0o755);
  assertBroadModeRejectedWithoutMutation(state, 0o755, 0o600, "broad state/private database");
  chmodSync(state, 0o700);
  chmodSync(join(state, databaseName), 0o644);
  assertBroadModeRejectedWithoutMutation(state, 0o700, 0o644, "private state/broad database");
  chmodSync(join(state, databaseName), 0o600);
  const reopened = openStore(state, "readonly-reopen");
  await reopened.acquire();
  stateModeEvidence(state, reopened.databasePath);
  reopened.close();
  integrityEvidence(join(state, databaseName));
  console.log(
    "PASS baseline modes/link-counts/integrity/lock-timeout/separate-broad-mode-rejects/reopen",
  );
}

async function lockHolder(databasePath: string, ready: string, release: string): Promise<void> {
  const database = new Database(databasePath, { strict: true });
  database.exec("BEGIN IMMEDIATE");
  writeFileSync(ready, "ready");
  await waitFor(release);
  database.exec("ROLLBACK");
  database.close(true);
}

async function canonicalWorker(root: string, moved: string): Promise<void> {
  const state = join(root, "canonical-state");
  let rejected = false;
  try {
    openStore(state, "canonical-held");
  } catch (cause: unknown) {
    rejected = cause instanceof StoreSecurityError;
  }
  assert(rejected, "attacker-controlled ancestor is rejected before SQLite opens");
  assert(readdirSync(state).length === 0, "rejected state directory remains empty");
  writeFileSync(marker("canonical-ready"), "ready");
  await waitFor(marker("canonical-go"));
  assert(!existsSync(join(state, databaseName)), "replacement receives no database state");
  assert(!existsSync(join(moved, databaseName)), "moved directory contains no database state");
}

function canonicalAttacker(state: string, moved: string): void {
  assert(process.getuid?.() === attackerUid, "path-swap attacker is UID 10002");
  renameSync(state, moved);
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(marker("canonical-go"), "go");
}

async function holdingVictim(state: string): Promise<void> {
  const store = openStore(state, "attacker-boundary");
  await store.acquire();
  writeFileSync(marker("attacker-ready"), "ready");
  await waitFor(marker("attacker-release"), 20_000);
  store.close();
}

function attackerProbe(state: string): void {
  assert(process.getuid?.() === attackerUid, "attacker worker is UID 10002");
  let writeDenied = false;
  let renameDenied = false;
  try {
    writeFileSync(join(state, "attacker"), "bad");
  } catch {
    writeDenied = true;
  }
  try {
    renameSync(state, `${state}-stolen`);
  } catch {
    renameDenied = true;
  }
  assert(writeDenied && renameDenied, "UID 10002 cannot write or replace victim state");
}

async function crashVictim(state: string): Promise<void> {
  const store = openStore(state, "crash-victim");
  const token = await store.acquire();
  const preparedInput = fixture(token, 20);
  assert((await store.createPrepared(preparedInput)).ok, "crash prepared fixture is durable");
  const input = fixture(token, 21);
  assert((await store.createPrepared(input)).ok, "crash submitting fixture is prepared");
  const claim = await store.claimPrepared({
    fencingToken: token,
    workspaceKey: workspace,
    deliveryId: input.id,
    nowMs: Date.now(),
  });
  assert(claim.ok && claim.delivery.state === "submitting", "crash fixture is submitting");
  writeFileSync(marker("crash-data"), JSON.stringify({ token: Number(token), id: input.id }));
  writeFileSync(marker("crash-ready"), "ready");
  await new Promise(() => undefined);
}

async function recoveryWorker(state: string, staleTokenNumber: number): Promise<void> {
  const store = openStore(state, "takeover");
  let nativeCalls = 0;
  const callLedger = marker("native-call-ledger");
  const result = await recoverMessageDeliveries(
    {
      membership: {
        readCurrentRoots: async () => ({
          sourceTitle: "source",
          sourceVisible: true,
          targetVisible: true,
        }),
      },
      deliveries: store,
      nativeQueue: {
        queueMessage: async () => {
          nativeCalls += 1;
          writeFileSync(callLedger, `${nativeCalls}\n`, { flag: "a", flush: true });
          return { kind: "unknown" as const };
        },
      },
      ownership: store,
      startupBarrier: store,
      clock: { nowMs: Date.now },
    },
    { workspaceKey: workspace, abort: new AbortController().signal, limit: 10 },
  );
  assert(
    result.ok && result.value.submittingMarkedUnknown === 1 && result.value.preparedSubmitted === 1,
    "one stale submission becomes unknown and one prepared delivery is submitted once",
  );
  assert(nativeCalls === 1, "only the prepared delivery makes one native call");
  assert(
    readFileSync(callLedger, "utf8") === "1\n",
    "native call ledger is persisted exactly once",
  );
  const currentToken = await store.acquire();
  assert(Number(currentToken) === staleTokenNumber + 1, "SIGKILL takeover increments epoch");
  const staleResult = await store.createPrepared(fixture(staleTokenNumber as FencingToken, 21));
  assert(!staleResult.ok && staleResult.code === "ownership_lost", "stale token is rejected");
  store.close();
  console.log("PASS SIGKILL prepared-once/submitting-no-call/persisted-ledger/stale-token");
}

async function stoppedVictim(state: string): Promise<void> {
  const store = openStore(state, "sigstop-victim");
  const token = await store.acquire();
  writeFileSync(marker("sigstop-token"), String(Number(token)));
  writeFileSync(marker("sigstop-ready"), "ready");
  await waitFor(marker("sigstop-resume"), 20_000);
  const stale = await store.createPrepared(fixture(token, 23));
  assert(!stale.ok && stale.code === "ownership_lost", "resumed stale process cannot write");
  assert(!(await store.isCurrent(token)), "resumed stale process cannot renew its token");
  store.close();
}

async function stopTakeover(state: string, staleToken: number): Promise<void> {
  const store = openStore(state, "sigstop-takeover");
  const token = await store.acquire();
  assert(Number(token) === staleToken + 1, "SIGSTOP delay increments fencing epoch");
  assert((await store.createPrepared(fixture(token, 22))).ok, "takeover writes with current token");
  store.close();
}

function maliciousProbe(state: string): void {
  let rejected = false;
  try {
    openStore(state, "malicious-probe");
  } catch (cause: unknown) {
    rejected = cause instanceof StoreSecurityError;
  }
  assert(rejected, `malicious object is rejected at ${state}`);
}

async function enospcWorker(root: string): Promise<void> {
  const state = join(root, "enospc-state");
  const store = openStore(state, "enospc");
  const token = await store.acquire();
  const filler = join(root, "real-enospc-filler");
  const descriptor = openSync(filler, constants.O_CREAT | constants.O_WRONLY, 0o600);
  const block = new Uint8Array(64 * 1024);
  let sawEnospc = false;
  try {
    for (let count = 0; count < 512; count += 1) writeSync(descriptor, block);
  } catch (cause: unknown) {
    sawEnospc = cause instanceof Error && "code" in cause && cause.code === "ENOSPC";
  } finally {
    closeSync(descriptor);
  }
  assert(sawEnospc, "bounded tmpfs produced real ENOSPC");
  const full = await store.createPrepared(fixture(token, 30));
  assert(
    !full.ok && full.code === "storage_unavailable",
    "kernel ENOSPC is classified as unavailable storage",
  );
  unlinkSync(filler);
  const reader = new Database(store.databasePath, { readonly: true, strict: true });
  const failedId = fixture(token, 30).id;
  assert(
    reader
      .query<{ count: number }, [string]>("SELECT count(*) AS count FROM deliveries WHERE id = ?")
      .get(failedId)?.count === 0,
    "failed ENOSPC row is absent after space is freed",
  );
  reader.close(true);
  integrityEvidence(store.databasePath);
  assert(
    (await store.createPrepared(fixture(token, 31))).ok,
    "store recovers after space is freed",
  );
  store.close();
  console.log("PASS real-ENOSPC rollback/integrity/foreign-keys/next-write");
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function launchWorker(mode: string, args: readonly string[], uid = victimUid): ChildProcess {
  return spawn(process.execPath, [driverPath, mode, ...args], {
    uid,
    gid: uid,
    env: { ...process.env, ACCEPTANCE_CHILD: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitChild(child: ChildProcess, timeoutMs = 15_000): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child timeout; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function requireSuccess(child: ChildProcess, label: string): Promise<ChildResult> {
  const result = await waitChild(child);
  assert(result.code === 0, `${label} failed: ${result.stderr || result.stdout}`);
  if (result.stdout.trim()) console.log(result.stdout.trim());
  return result;
}

function prepareState(root: string, name: string): string {
  const state = join(root, name);
  mkdirSync(state, { mode: 0o700 });
  chownSync(state, victimUid, victimUid);
  chmodSync(state, 0o700);
  return state;
}

async function listenUnix(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

async function stageMalicious(path: string, kind: string): Promise<Server | undefined> {
  if (kind === "symlink") symlinkSync("/dev/null", path);
  if (kind === "fifo") {
    const result = spawnSync("mkfifo", [path]);
    assert(result.status === 0, `mkfifo works: ${String(result.stderr)}`);
  }
  if (kind === "directory") mkdirSync(path);
  if (kind === "socket") return await listenUnix(path);
  if (kind === "hardlink") {
    const sourcePath = `${path}.source`;
    writeFileSync(sourcePath, "malicious");
    linkSync(sourcePath, path);
    chownSync(sourcePath, victimUid, victimUid);
    const sourceStat = lstatSync(sourcePath);
    const targetStat = lstatSync(path);
    assert(
      sourceStat.uid === victimUid && targetStat.uid === victimUid,
      "hardlink fixture is victim-owned",
    );
    assert(sourceStat.nlink === 2 && targetStat.nlink === 2, "hardlink fixture has nlink=2");
  }
  if (kind === "device") {
    const result = spawnSync("mknod", [path, "c", "1", "3"]);
    assert(
      result.status === 0,
      `actual character-device fixture requires Docker CAP_MKNOD: ${String(result.stderr)}`,
    );
    chownSync(path, victimUid, victimUid);
    assert(lstatSync(path).isCharacterDevice(), "malicious fixture is an actual character device");
  }
  if (kind === "foreign-owner") {
    writeFileSync(path, "malicious", { mode: 0o600 });
    chownSync(path, attackerUid, attackerUid);
  }
  return undefined;
}

async function maliciousMatrix(root: string): Promise<void> {
  const suffixes = ["", "-wal", "-shm", "-journal"];
  const kinds = ["symlink", "fifo", "directory", "socket", "hardlink", "foreign-owner"];
  if (process.env.ACCEPTANCE_FS === "overlay") kinds.push("device");
  else console.log("N/A character-device fixture on nodev tmpfs; OverlayFS cell is required");
  let count = 0;
  for (const suffix of suffixes) {
    for (const kind of kinds) {
      const state = prepareState(root, `malicious-${count}`);
      const server = await stageMalicious(join(state, `${databaseName}${suffix}`), kind);
      const result = await waitChild(launchWorker("malicious-probe", [state]));
      server?.close();
      assert(result.code === 0, `${kind} ${suffix || "main"} rejection: ${result.stderr}`);
      count += 1;
    }
  }
  console.log(
    `PASS malicious-object matrix (${count}: main/WAL/SHM/journal x ${kinds.length} object types)`,
  );
}

async function canonicalScenario(root: string): Promise<void> {
  // The victim-owned mount root remains non-writable but allows UID 10002 to reach the
  // deliberately attacker-controlled writable ancestor used for this race.
  chmodSync(root, 0o711);
  const ancestor = join(root, "canonical-writable-ancestor");
  mkdirSync(ancestor, { mode: 0o777 });
  chownSync(ancestor, attackerUid, attackerUid);
  chmodSync(ancestor, 0o777);
  const state = join(ancestor, "canonical-state");
  mkdirSync(state, { mode: 0o700 });
  chownSync(state, victimUid, victimUid);
  const moved = join(ancestor, "canonical-held-moved");
  const child = launchWorker("canonical", [ancestor, moved]);
  await waitFor(marker("canonical-ready"));
  await requireSuccess(
    launchWorker("canonical-attacker", [state, moved], attackerUid),
    "UID 10002 canonical swap",
  );
  await requireSuccess(child, "canonical identity fail-closed scenario");
  assert(readdirSync(state).length === 0, "no state appears outside held directory");
  assert(lstatSync(state).uid === attackerUid, "replacement remains attacker-owned");
  chmodSync(root, 0o700);
  console.log("PASS UID-10002 untrusted-ancestor/path-swap/fail-closed/no-state");
}

async function attackerScenario(root: string): Promise<void> {
  const state = join(root, "attacker-state");
  const victim = launchWorker("holding-victim", [state]);
  await waitFor(marker("attacker-ready"));
  await requireSuccess(launchWorker("attacker-probe", [state], attackerUid), "UID attacker");
  writeFileSync(marker("attacker-release"), "release");
  await requireSuccess(victim, "holding victim");
  console.log("PASS victim-UID-10001/attacker-UID-10002 boundary");
}

async function crashScenario(root: string): Promise<void> {
  const state = join(root, "crash-state");
  const crashed = launchWorker("crash-victim", [state]);
  await waitFor(marker("crash-ready"));
  const data = JSON.parse(readFileSync(marker("crash-data"), "utf8")) as { token: number };
  crashed.kill("SIGKILL");
  const death = await waitChild(crashed);
  assert(death.signal === "SIGKILL", "victim really died by SIGKILL");
  await Bun.sleep(1_250);
  await requireSuccess(launchWorker("recovery", [state, String(data.token)]), "SIGKILL recovery");
}

async function sigstopScenario(root: string): Promise<void> {
  const state = join(root, "sigstop-state");
  const victim = launchWorker("stopped-victim", [state]);
  await waitFor(marker("sigstop-ready"));
  const staleToken = Number(readFileSync(marker("sigstop-token"), "utf8"));
  victim.kill("SIGSTOP");
  await Bun.sleep(1_250);
  await requireSuccess(
    launchWorker("stop-takeover", [state, String(staleToken)]),
    "SIGSTOP takeover",
  );
  writeFileSync(marker("sigstop-resume"), "resume");
  victim.kill("SIGCONT");
  await requireSuccess(victim, "resumed stale SIGSTOP victim");
  console.log("PASS SIGSTOP delayed-renewal/takeover/no-stale-renewal-or-write");
}

async function readonlyInit(state: string): Promise<void> {
  chownSync(state, victimUid, victimUid);
  chmodSync(state, 0o700);
  await requireSuccess(launchWorker("readonly-seed", [state]), "read-only volume RW seed");
}

async function readonlySeed(state: string): Promise<void> {
  const store = openStore(state, "readonly-seed");
  const token = await store.acquire();
  assert((await store.createPrepared(fixture(token, 90))).ok, "read-only volume seed succeeds RW");
  store.close();
}

function readonlyProbe(state: string): void {
  const paths = readdirSync(state)
    .map((name) => join(state, name))
    .filter((path) => lstatSync(path).isFile());
  assert(paths.length > 0, "read-only mount contains initialized SQLite state");
  const before = new Map(paths.map((path) => [path, fileIdentity(path)]));
  const started = performance.now();
  let failure: unknown;
  try {
    openStore(state, "readonly-probe");
  } catch (cause: unknown) {
    failure = cause;
  }
  assert(
    failure instanceof StoreSecurityError,
    "read-only mount fails closed with a sanitized error",
  );
  assert(!String(failure).includes(state), "read-only failure does not expose the state path");
  assert(performance.now() - started < 2_000, "read-only failure is prompt");
  for (const [path, identity] of before) {
    assert(existsSync(path), "read-only fixture file remains present");
    assert(fileIdentity(path).inode === identity.inode, "read-only fixture inode is unchanged");
    assert(fileIdentity(path).hash === identity.hash, "read-only fixture hash is unchanged");
  }
  console.log("PASS real-read-only-mount/prompt-sanitized-fail-closed/unchanged-inodes-hashes");
}

function runtimeEvidence(root: string): void {
  assert(Bun.version === "1.4.0", `exact Bun version (got ${Bun.version})`);
  const release = readFileSync("/etc/os-release", "utf8").replaceAll("\n", ";");
  const ldd = spawnSync("ldd", ["--version"], { encoding: "utf8" });
  const libc = `${ldd.stdout}${ldd.stderr}`.trim().replaceAll("\n", ";");
  const expected = process.env.ACCEPTANCE_LIBC;
  assert(
    expected === "debian" ? /glibc|GNU libc/i.test(libc) : /musl/i.test(libc),
    "libc matches image",
  );
  const magic = statfsSync(root, { bigint: true }).type;
  const filesystem = process.env.ACCEPTANCE_FS;
  assert(
    filesystem === "overlay" ? magic === 0x794c_7630n : magic === 0x0102_1994n,
    `${filesystem} filesystem magic is expected (${magic.toString(16)})`,
  );
  console.log(
    `EVIDENCE bun=${Bun.version} uid=${process.getuid?.()} libc=${libc} fs=${filesystem} magic=0x${magic.toString(16)} os=${release}`,
  );
}

async function orchestrate(): Promise<void> {
  assert(process.platform === "linux", "harness runs on Linux");
  assert(process.getuid?.() === 0, "orchestrator starts as root");
  const root = process.env.ACCEPTANCE_ROOT;
  assert(root, "ACCEPTANCE_ROOT is set");
  runtimeEvidence(root);
  for (const entry of readdirSync(root)) resetPath(join(root, entry));
  for (const entry of readdirSync(controlRoot)) resetPath(join(controlRoot, entry));

  await requireSuccess(launchWorker("baseline", [root]), "baseline");
  await canonicalScenario(root);
  await attackerScenario(root);
  await maliciousMatrix(root);
  await crashScenario(root);
  await sigstopScenario(root);
  if (process.env.ACCEPTANCE_FS === "tmpfs") {
    await requireSuccess(launchWorker("enospc", [root]), "ENOSPC");
  } else {
    console.log("N/A real-ENOSPC: deliberately limited to daemon-bounded tmpfs");
  }
  console.log(`PASS complete ${process.env.ACCEPTANCE_LIBC}/${process.env.ACCEPTANCE_FS}`);
}

async function childMain(mode: string, args: readonly string[]): Promise<void> {
  switch (mode) {
    case "baseline":
      return await baselineWorker(args[0] ?? "");
    case "lock-holder":
      return await lockHolder(args[0] ?? "", args[1] ?? "", args[2] ?? "");
    case "canonical":
      return await canonicalWorker(args[0] ?? "", args[1] ?? "");
    case "canonical-attacker":
      return canonicalAttacker(args[0] ?? "", args[1] ?? "");
    case "holding-victim":
      return await holdingVictim(args[0] ?? "");
    case "attacker-probe":
      return attackerProbe(args[0] ?? "");
    case "crash-victim":
      return await crashVictim(args[0] ?? "");
    case "recovery":
      return await recoveryWorker(args[0] ?? "", Number(args[1]));
    case "stopped-victim":
      return await stoppedVictim(args[0] ?? "");
    case "stop-takeover":
      return await stopTakeover(args[0] ?? "", Number(args[1]));
    case "readonly-seed":
      return await readonlySeed(args[0] ?? "");
    case "malicious-probe":
      return maliciousProbe(args[0] ?? "");
    case "enospc":
      return await enospcWorker(args[0] ?? "");
    default:
      throw new Error(`unknown acceptance child mode: ${mode}`);
  }
}

const mode = process.argv[2];
if (process.env.ACCEPTANCE_CHILD === "1") {
  await childMain(mode ?? "", process.argv.slice(3));
} else if (mode === "readonly-init") {
  await readonlyInit(process.argv[3] ?? "/readonly-state");
} else if (mode === "readonly-probe") {
  readonlyProbe(process.argv[3] ?? "/readonly-state");
} else {
  await orchestrate();
}
