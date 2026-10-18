import { createHash, randomBytes } from "node:crypto";
import type { SessionExportAdapterPort } from "../../application/session-export-ports";
import type { NativeSessionReadPort } from "../../application/session-read-ports";
import { validateExportDestination } from "../../domain/session-export";
import { sessionReadLimits } from "../../domain/session-read";
import {
  createSessionExportLimits,
  ProcessLocalExportLimiter,
  type SessionExportLimits,
} from "./export-limits";
import { ExportPathError, type LinuxExportRoot } from "./linux-export-destination";

function guardFailure(
  status: Awaited<
    ReturnType<Parameters<SessionExportAdapterPort["writeExport"]>[0]["guard"]["check"]>
  >,
) {
  return status === "current" ? undefined : status;
}

function pathFailure(cause: unknown) {
  return cause instanceof ExportPathError ? cause.kind : ("storage_unavailable" as const);
}

export class SanitizedContextExportAdapter implements SessionExportAdapterPort, Disposable {
  private readonly limits: SessionExportLimits;
  private readonly limiter: ProcessLocalExportLimiter;
  private draining = false;

  constructor(
    private readonly root: LinuxExportRoot,
    private readonly native: NativeSessionReadPort,
    limits?: Partial<SessionExportLimits>,
  ) {
    this.limits = createSessionExportLimits(limits);
    this.limiter = new ProcessLocalExportLimiter(
      this.limits.maximumConcurrent,
      this.limits.maximumSourceExportsPerMinute,
      this.limits.maximumWorkspaceExportsPerMinute,
    );
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the guard/read/stage/install sequence is one fail-closed external-effect proof.
  async writeExport(
    input: Parameters<SessionExportAdapterPort["writeExport"]>[0],
  ): ReturnType<SessionExportAdapterPort["writeExport"]> {
    const release = this.limiter.tryAcquire({
      source: input.sourceSessionId,
      workspace: input.workspaceKey,
    });
    if (!release) return { ok: false, code: "export_limit_exceeded" };
    let temporary: ReturnType<LinuxExportRoot["createTemporary"]> | undefined;
    let installed = false;
    try {
      if (
        this.draining ||
        input.abort.aborted ||
        Date.now() >= input.deadlineMs ||
        !input.isSanitized ||
        !validateExportDestination(input.destination).ok
      )
        return { ok: false, code: "export_limit_exceeded" };
      const initial = guardFailure(await input.guard.check());
      if (initial) return { ok: false, code: initial };
      const descending = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let projectionBytes = 0;
      let cursor: string | null = null;
      for (let calls = 0; calls < sessionReadLimits.maxNativeCalls; calls += 1) {
        const guarded = guardFailure(await input.guard.check());
        if (guarded) return { ok: false, code: guarded };
        if (projectionBytes >= sessionReadLimits.maxNativeResponseBytesExamined) {
          return { ok: false, code: "export_limit_exceeded" };
        }
        const page = await this.native.readMessagePage({
          workspaceKey: input.workspaceKey,
          sessionId: input.sessionId,
          ...(cursor === null ? { order: "desc" as const } : { cursor }),
          maximumResponseBytes: Math.min(
            sessionReadLimits.maxNativeResponseBytes,
            sessionReadLimits.maxNativeResponseBytesExamined - projectionBytes,
          ),
          abort: input.abort,
        });
        projectionBytes += page.rawResponseByteCount;
        if (
          !Number.isSafeInteger(projectionBytes) ||
          page.rawResponseByteCount < 0 ||
          projectionBytes > sessionReadLimits.maxNativeResponseBytesExamined
        ) {
          return { ok: false, code: "export_limit_exceeded" };
        }
        if (page.examinedMessageCount !== page.examinedMessageIds.length) {
          return { ok: false, code: "export_unavailable" };
        }
        for (const id of page.examinedMessageIds) {
          if (ids.has(id)) return { ok: false, code: "export_unavailable" };
          ids.add(id);
        }
        descending.push(...page.messages);
        if (descending.length > sessionReadLimits.maxMessagesExamined) {
          return { ok: false, code: "export_limit_exceeded" };
        }
        if (page.nextCursor === null) break;
        if (!page.nextCursor || cursors.has(page.nextCursor)) {
          return { ok: false, code: "export_unavailable" };
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
        if (calls === sessionReadLimits.maxNativeCalls - 1) {
          return { ok: false, code: "export_limit_exceeded" };
        }
      }
      const document = {
        version: 1,
        kind: "opencode-sanitized-current-context",
        history_complete: false,
        projection_version: 1,
        communicator: {
          source_session_id: input.sourceSessionId,
          target_session_id: input.sessionId,
        },
        messages: descending.reverse(),
      };
      const bytes = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
      if (bytes.byteLength > this.limits.maximumOutputBytes) {
        return { ok: false, code: "export_limit_exceeded" };
      }
      const beforeCreate = guardFailure(await input.guard.check());
      if (beforeCreate) return { ok: false, code: beforeCreate };
      temporary = this.root.createTemporary(input.destination, randomBytes(16).toString("hex"));
      if (input.abort.aborted || Date.now() >= input.deadlineMs) {
        return { ok: false, code: "native_outcome_unknown" };
      }
      const beforeWrite = guardFailure(await input.guard.check());
      if (beforeWrite) return { ok: false, code: beforeWrite };
      temporary.write(bytes);
      const beforeInstall = guardFailure(await input.guard.check());
      if (beforeInstall || input.abort.aborted || Date.now() >= input.deadlineMs) {
        return { ok: false, code: beforeInstall ?? "native_outcome_unknown" };
      }
      temporary.install(input.shouldOverwrite);
      temporary = undefined;
      installed = true;
      if ((await input.guard.check()) !== "current") {
        return { ok: false, code: "native_outcome_unknown" };
      }
      return {
        ok: true,
        byteCount: bytes.byteLength,
        contentSha256: createHash("sha256").update(bytes).digest("hex") as never,
      };
    } catch (cause: unknown) {
      return { ok: false, code: installed ? "native_outcome_unknown" : pathFailure(cause) };
    } finally {
      temporary?.discard();
      release();
    }
  }

  async drain(): Promise<void> {
    this.draining = true;
  }

  [Symbol.dispose](): void {
    this.draining = true;
    this.root.close();
  }
}
