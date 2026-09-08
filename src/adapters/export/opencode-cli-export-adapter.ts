import { randomBytes } from "node:crypto";

import type { SessionExportAdapterPort } from "../../application/session-export-ports";
import { isSupportedOpenCodeVersion } from "../../domain/host";
import type { Sha256Digest } from "../../domain/message-payload";
import { validateExportDestination } from "../../domain/session-export";
import {
  bunExportSpawnPort,
  type ExportSpawnPort,
  runBoundedBunProcess,
} from "./bounded-bun-process";
import {
  createSessionExportLimits,
  ProcessLocalExportLimiter,
  type SessionExportLimits,
} from "./export-limits";
import { ExportPathError, type LinuxExportRoot } from "./linux-export-destination";
import { NativeExportCapture } from "./native-export-capture";
import {
  closeOptionalDescriptor,
  type ExecutableIdentity,
  executableIdentity,
  minimalEnvironment,
  type OpenCodeCliExportConfiguration,
  prepareExactExecutable,
  prepareTrustedWorkingDirectory,
  sameExecutable,
  trustedWorkingDirectory,
} from "./opencode-cli-trust";

export type { OpenCodeCliExportConfiguration } from "./opencode-cli-trust";

function pathFailure(
  cause: unknown,
): "unsafe_path" | "destination_exists" | "native_outcome_unknown" | "storage_unavailable" {
  return cause instanceof ExportPathError ? cause.kind : "storage_unavailable";
}

function preEffectFailure(
  status: Awaited<
    ReturnType<Parameters<SessionExportAdapterPort["writeExport"]>[0]["guard"]["check"]>
  >,
):
  | "caller_not_visible"
  | "target_not_visible"
  | "ownership_lost"
  | "export_unavailable"
  | undefined {
  return status === "current" ? undefined : status;
}

export class OpenCodeCliExportAdapter implements SessionExportAdapterPort, Disposable {
  private readonly limits: SessionExportLimits;
  private readonly limiter: ProcessLocalExportLimiter;
  private readonly spawn: ExportSpawnPort;
  private readonly randomHex: () => string;
  private readonly trustedCwd: ReturnType<typeof prepareTrustedWorkingDirectory>;
  private readonly activeProcesses = new Set<Promise<unknown>>();
  private readonly shutdownAbort = new AbortController();
  private isDraining = false;
  private isDisposed = false;
  private drainPromise: Promise<void> | undefined;

  constructor(
    private readonly root: LinuxExportRoot,
    private readonly configuration: OpenCodeCliExportConfiguration,
  ) {
    this.limits = createSessionExportLimits(configuration.limits);
    this.limiter = new ProcessLocalExportLimiter(
      this.limits.maximumConcurrent,
      this.limits.maximumSourceExportsPerMinute,
      this.limits.maximumWorkspaceExportsPerMinute,
    );
    this.spawn = configuration.spawn ?? bunExportSpawnPort;
    this.randomHex = configuration.randomHex ?? (() => randomBytes(16).toString("hex"));
    this.trustedCwd = prepareTrustedWorkingDirectory(configuration);
  }

  private async verifyVersion(
    input: Parameters<SessionExportAdapterPort["writeExport"]>[0],
    identity: ExecutableIdentity,
    command: string,
  ): Promise<
    | "verified"
    | "caller_not_visible"
    | "target_not_visible"
    | "ownership_lost"
    | "export_unavailable"
    | "export_limit_exceeded"
    | "native_outcome_unknown"
  > {
    const guardFailure = preEffectFailure(await input.guard.check());
    if (guardFailure) return guardFailure;
    const version = await this.runProcess({
      ...this.processInput(input, command),
      arguments: ["--version"],
      stdoutLimit: 64,
    });
    if (version.kind === "ambiguous") return "native_outcome_unknown";
    if (version.kind === "limit") return "export_limit_exceeded";
    if (
      version.kind !== "completed" ||
      version.exitCode !== 0 ||
      !isSupportedOpenCodeVersion(new TextDecoder().decode(version.stdout).trim())
    ) {
      return "export_unavailable";
    }
    if ((await input.guard.check()) !== "current") return "native_outcome_unknown";
    return this.hasSameIdentity(identity) ? "verified" : "export_unavailable";
  }

  private processInput(
    input: Parameters<SessionExportAdapterPort["writeExport"]>[0],
    command: string,
  ) {
    return {
      command,
      cwd: this.trustedCwd.commandPath,
      environment: minimalEnvironment(this.configuration.environment),
      abort: input.abort,
      deadlineMs: input.deadlineMs,
      limits: this.limits,
    };
  }

  private runProcess(
    input: Parameters<typeof runBoundedBunProcess>[1],
  ): ReturnType<typeof runBoundedBunProcess> {
    const execution = runBoundedBunProcess(this.spawn, {
      ...input,
      abort: AbortSignal.any([input.abort, this.shutdownAbort.signal]),
    });
    this.activeProcesses.add(execution);
    const remove = (): void => {
      this.activeProcesses.delete(execution);
    };
    execution.then(remove, remove);
    return execution;
  }

  private isActive(input: Parameters<SessionExportAdapterPort["writeExport"]>[0]): boolean {
    return !input.abort.aborted && Date.now() < input.deadlineMs;
  }

  private canContinue(input: Parameters<SessionExportAdapterPort["writeExport"]>[0]): boolean {
    return !this.isDraining && !this.isDisposed && this.isActive(input);
  }

  private hasSameIdentity(identity: ExecutableIdentity): boolean {
    try {
      return sameExecutable(identity, executableIdentity(this.configuration));
    } catch {
      return false;
    }
  }

  private configurationIsTrusted(): boolean {
    try {
      minimalEnvironment(this.configuration.environment);
      if (this.isDraining || this.isDisposed) return false;
      trustedWorkingDirectory(this.configuration);
      return true;
    } catch {
      return false;
    }
  }

  private async captureExport(
    input: Parameters<SessionExportAdapterPort["writeExport"]>[0],
    executable: { readonly identity: ExecutableIdentity; readonly command: string },
    temporary: ReturnType<LinuxExportRoot["createTemporary"]>,
  ): Promise<
    | {
        readonly ok: false;
        readonly code: "native_outcome_unknown" | "export_limit_exceeded" | "export_unavailable";
      }
    | { readonly ok: true; readonly byteCount: number; readonly digest: Sha256Digest }
  > {
    const capture = new NativeExportCapture({
      temporary,
      sessionId: input.sessionId,
      isSanitized: input.isSanitized,
      deadlineMs: input.deadlineMs,
    });
    const exported = await this.runProcess({
      ...this.processInput(input, executable.command),
      arguments: ["export", input.sessionId, ...(input.isSanitized ? ["--sanitize"] : [])],
      stdoutLimit: this.limits.maximumOutputBytes,
      onStdout: (chunk) => capture.write(chunk),
      shouldRetainStdout: false,
    });
    if (exported.kind === "ambiguous") return { ok: false, code: "native_outcome_unknown" };
    if (exported.kind === "limit") return { ok: false, code: "export_limit_exceeded" };
    if (exported.kind !== "completed" || exported.exitCode !== 0) {
      return { ok: false, code: "export_unavailable" };
    }
    if ((await input.guard.check()) !== "current" || !this.hasSameIdentity(executable.identity)) {
      return { ok: false, code: "native_outcome_unknown" };
    }
    const captured = capture.finish();
    if (!captured.ok) {
      if (captured.validation.reason === "limit")
        return { ok: false, code: "export_limit_exceeded" };
      if (captured.validation.reason === "deadline")
        return { ok: false, code: "native_outcome_unknown" };
      return { ok: false, code: "export_unavailable" };
    }
    return captured;
  }

  async writeExport(
    input: Parameters<SessionExportAdapterPort["writeExport"]>[0],
  ): ReturnType<SessionExportAdapterPort["writeExport"]> {
    const release = this.limiter.tryAcquire({
      source: input.sourceSessionId,
      workspace: input.workspaceKey,
    });
    if (!release) return { ok: false, code: "export_limit_exceeded" };
    let temporary: ReturnType<LinuxExportRoot["createTemporary"]> | undefined;
    let executableDescriptor: number | undefined;
    try {
      if (!this.isActive(input)) return { ok: false, code: "export_limit_exceeded" };
      if (!validateExportDestination(input.destination).ok)
        return { ok: false, code: "unsafe_path" };
      const initialGuard = preEffectFailure(await input.guard.check());
      if (initialGuard) return { ok: false, code: initialGuard };
      if (!this.configurationIsTrusted()) return { ok: false, code: "export_unavailable" };
      const executable = prepareExactExecutable(this.configuration);
      if (!executable) return { ok: false, code: "export_unavailable" };
      executableDescriptor = executable.descriptor;
      const verification = await this.verifyVersion(input, executable.identity, executable.command);
      if (verification !== "verified") return { ok: false, code: verification };
      const temporaryGuard = preEffectFailure(await input.guard.check());
      if (temporaryGuard) return { ok: false, code: temporaryGuard };
      if (!this.canContinue(input)) return { ok: false, code: "export_limit_exceeded" };
      temporary = this.root.createTemporary(input.destination, this.randomHex());
      const exportGuard = preEffectFailure(await input.guard.check());
      if (exportGuard) return { ok: false, code: exportGuard };
      if (!this.canContinue(input)) return { ok: false, code: "export_limit_exceeded" };
      const captured = await this.captureExport(input, executable, temporary);
      if (!captured.ok) return captured;
      const installGuard = preEffectFailure(await input.guard.check());
      if (installGuard) return { ok: false, code: installGuard };
      if (!this.canContinue(input)) return { ok: false, code: "export_limit_exceeded" };
      temporary.install(input.shouldOverwrite);
      temporary = undefined;
      if ((await input.guard.check()) !== "current") {
        return { ok: false, code: "native_outcome_unknown" };
      }
      return { ok: true, byteCount: captured.byteCount, contentSha256: captured.digest };
    } catch (cause: unknown) {
      return { ok: false, code: pathFailure(cause) };
    } finally {
      temporary?.discard();
      closeOptionalDescriptor(executableDescriptor);
      release();
    }
  }

  drain(): Promise<void> {
    this.drainPromise ??= (async () => {
      this.isDraining = true;
      this.shutdownAbort.abort("communicator_shutdown");
      // Each owned execution has a finite TERM -> KILL protocol bounded by twice terminationGraceMs.
      await Promise.allSettled([...this.activeProcesses]);
    })();
    return this.drainPromise;
  }

  [Symbol.dispose](): void {
    if (this.isDisposed) return;
    this.isDraining = true;
    this.shutdownAbort.abort("communicator_shutdown");
    if (this.activeProcesses.size > 0) {
      throw new Error("Active export processes must be drained before disposal.");
    }
    this.isDisposed = true;
    closeOptionalDescriptor(this.trustedCwd.descriptor);
    this.root.close();
  }
}
