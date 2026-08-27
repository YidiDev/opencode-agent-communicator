import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionExportRequest, SessionExportSummary } from "../domain/session-export";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { boundedExternalCall } from "./bounded-external-call";
import {
  assertCommunicatorReady,
  communicatorLifecycleFencingToken,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type { CurrentRootMembership } from "./delivery-ports";
import type {
  ExportApprovalBinding,
  ExportEffectGuardPort,
  SessionExportPorts,
} from "./session-export-ports";
import { type SessionExportArguments, sessionExportRequest } from "./session-export-request";
import { exportAdapterFailure, isExportAdapterResult } from "./session-export-result";
import { snapshotDataRecord } from "./strict-port-boundaries";

export type { SessionExportArguments } from "./session-export-request";

function effectGuard(
  ports: SessionExportPorts,
  context: SessionExportContext,
  target: SessionId,
  fencingToken: Parameters<SessionExportPorts["ownership"]["isCurrent"]>[0],
): ExportEffectGuardPort {
  return {
    async check() {
      const ownership = await boundedExternalCall(
        () => ports.ownership.isCurrent(fencingToken),
        context.abort,
        context.deadlineMs,
      );
      if (ownership.kind === "expired") return "export_unavailable";
      if (ownership.kind === "rejected") {
        if (ownership.cause instanceof OwnershipLostFault) {
          stopCommunicatorForOwnershipLoss(ports.readiness);
          return "ownership_lost";
        }
        return "export_unavailable";
      }
      if (typeof ownership.value !== "boolean") return "export_unavailable";
      if (!ownership.value) {
        stopCommunicatorForOwnershipLoss(ports.readiness);
        return "ownership_lost";
      }
      const observed = await observeMembership(ports, context, target);
      if (!observed.ok) return "export_unavailable";
      if (!observed.value.sourceVisible) return "caller_not_visible";
      return observed.value.targetVisible ? "current" : "target_not_visible";
    },
  };
}

function effectGuardFailure(
  status: Awaited<ReturnType<ExportEffectGuardPort["check"]>>,
): DomainResult<never> | undefined {
  if (status === "current") return undefined;
  if (status === "caller_not_visible") {
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  }
  if (status === "target_not_visible") {
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  }
  return exportAdapterFailure(status === "export_unavailable" ? status : "ownership_lost");
}

function hasCurrentDeadline(context: SessionExportContext): boolean {
  return Number.isSafeInteger(context.deadlineMs) && context.deadlineMs > Date.now();
}

export interface SessionExportContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
}

async function observeMembership(
  ports: SessionExportPorts,
  context: SessionExportContext,
  target: SessionId,
): Promise<DomainResult<CurrentRootMembership>> {
  try {
    const call = await boundedExternalCall(
      () =>
        ports.membership.readCurrentRoots(context.workspaceKey, context.sourceSessionId, target),
      context.abort,
      context.deadlineMs,
    );
    if (call.kind === "expired") {
      return domainFailure(
        "export_limit_exceeded",
        "The export invocation deadline elapsed.",
        false,
      );
    }
    if (call.kind === "rejected") throw call.cause;
    const raw: unknown = call.value;
    const value = snapshotDataRecord(raw, 3);
    if (
      !value ||
      Object.keys(value).length !== 3 ||
      typeof value.sourceVisible !== "boolean" ||
      typeof value.targetVisible !== "boolean" ||
      (value.sourceTitle !== undefined && typeof value.sourceTitle !== "string")
    ) {
      return domainFailure("export_unavailable", "Current session state is unavailable.", true);
    }
    return {
      ok: true,
      value: {
        sourceVisible: value.sourceVisible,
        targetVisible: value.targetVisible,
        sourceTitle: value.sourceTitle,
      },
    };
  } catch (cause: unknown) {
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : domainFailure("export_unavailable", "Current session state is unavailable.", true);
  }
}

function visibility(value: CurrentRootMembership): DomainResult<never> | undefined {
  if (!value.sourceVisible) {
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  }
  if (!value.targetVisible) {
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  }
  return undefined;
}

async function authorize(
  ports: SessionExportPorts,
  context: SessionExportContext,
  request: SessionExportRequest,
): Promise<DomainResult<undefined>> {
  const decisions = ports.policy.decisionFor({
    isSelf: request.sessionId === context.sourceSessionId,
    isSanitized: request.isSanitized,
    shouldOverwrite: request.shouldOverwrite,
  });
  if (
    !decisions ||
    Object.keys(decisions).some((key) => key !== "mode" && key !== "overwrite") ||
    (decisions.mode !== "allow" && decisions.mode !== "ask" && decisions.mode !== "deny") ||
    (decisions.overwrite !== undefined &&
      decisions.overwrite !== "allow" &&
      decisions.overwrite !== "ask" &&
      decisions.overwrite !== "deny")
  ) {
    return domainFailure("export_unavailable", "Session export policy is unavailable.", false);
  }
  const binding: ExportApprovalBinding = {
    workspaceKey: context.workspaceKey,
    sourceSessionId: context.sourceSessionId,
    targetSessionId: request.sessionId,
    destination: request.destination,
    isSanitized: request.isSanitized,
    shouldOverwrite: request.shouldOverwrite,
  };
  const decide = async (
    kind: "mode" | "overwrite",
    decision: "allow" | "ask" | "deny",
  ): Promise<DomainResult<undefined>> => {
    if (decision === "deny") {
      return domainFailure("permission_denied", "Session export is denied by policy.", false);
    }
    if (decision === "ask") {
      const call = await boundedExternalCall(
        () =>
          ports.approval.requestExportApproval(kind, binding, {
            abort: context.abort,
            deadlineMs: context.deadlineMs,
          }),
        context.abort,
        context.deadlineMs,
      );
      if (call.kind === "expired") {
        return domainFailure(
          "export_limit_exceeded",
          "The export invocation deadline elapsed.",
          false,
        );
      }
      if (call.kind === "rejected") {
        return domainFailure("export_unavailable", "Session export approval is unavailable.", true);
      }
      const approved = call.value;
      if (approved !== "approved" && approved !== "rejected") {
        return domainFailure(
          "export_unavailable",
          "Session export approval is unavailable.",
          false,
        );
      }
      if (approved !== "approved") {
        return domainFailure("approval_rejected", "Session export approval was rejected.", false);
      }
    }
    return { ok: true, value: undefined };
  };
  const mode = await decide("mode", decisions.mode);
  if (!mode.ok) return mode;
  return decisions.overwrite === undefined
    ? { ok: true, value: undefined }
    : decide("overwrite", decisions.overwrite);
}

export async function exportSession(
  ports: SessionExportPorts,
  context: SessionExportContext,
  args: SessionExportArguments,
): Promise<DomainResult<SessionExportSummary>> {
  assertCommunicatorReady(ports.readiness);
  if (!hasCurrentDeadline(context)) {
    return domainFailure("export_limit_exceeded", "The export invocation deadline elapsed.", false);
  }
  const parsed = sessionExportRequest(context.sourceSessionId, args);
  if (!parsed.ok) return parsed;
  const first = await observeMembership(ports, context, parsed.value.sessionId);
  if (!first.ok) return first;
  const firstVisibility = visibility(first.value);
  if (firstVisibility) return firstVisibility;
  const authorization = await authorize(ports, context, parsed.value);
  if (!authorization.ok) return authorization;
  const current = await observeMembership(ports, context, parsed.value.sessionId);
  if (!current.ok) return current;
  const currentVisibility = visibility(current.value);
  if (currentVisibility) return currentVisibility;

  try {
    const fencingToken = communicatorLifecycleFencingToken(ports.readiness);
    const guard = effectGuard(ports, context, parsed.value.sessionId, fencingToken);
    const guarded = effectGuardFailure(await guard.check());
    if (guarded) return guarded;
    const exported = await boundedExternalCall(
      () =>
        ports.exporter.writeExport({
          sessionId: parsed.value.sessionId,
          sourceSessionId: context.sourceSessionId,
          workspaceKey: context.workspaceKey,
          destination: parsed.value.destination,
          isSanitized: parsed.value.isSanitized,
          shouldOverwrite: parsed.value.shouldOverwrite,
          abort: context.abort,
          deadlineMs: context.deadlineMs,
          fencingToken,
          guard,
        }),
      context.abort,
      context.deadlineMs,
    );
    if (exported.kind !== "value") return exportAdapterFailure("native_outcome_unknown");
    const result = exported.value;
    if (!isExportAdapterResult(result)) return exportAdapterFailure("export_unavailable");
    if (!result.ok) return exportAdapterFailure(result.code);
    if ((await guard.check()) !== "current") return exportAdapterFailure("native_outcome_unknown");
    return {
      ok: true,
      value: {
        sessionId: parsed.value.sessionId,
        destination: parsed.value.destination,
        isSanitized: parsed.value.isSanitized,
        byteCount: result.byteCount,
        contentSha256: result.contentSha256,
      },
    };
  } catch (cause: unknown) {
    return cause instanceof OwnershipLostFault
      ? exportAdapterFailure("ownership_lost")
      : exportAdapterFailure("storage_unavailable");
  }
}
