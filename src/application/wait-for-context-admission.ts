import type { ContextAdmissionMetadata } from "../domain/context-admissions";
import type { RequestId } from "../domain/generated-ids";
import type { FencingToken } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { boundedExternalCall } from "./bounded-external-call";
import type { ContextAdmissionPersistencePort } from "./context-admission-ports";
import type { ContextAdmissionRegistration } from "./context-admission-runtime";
import { terminalRequestFailure } from "./request-terminal-failures";

const contextAdmissionIoTimeoutMs = 1_000;

interface ContextAdmissionParentRequestPort {
  getRequestMetadata(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly requestId: RequestId;
  }): Promise<RequestMetadata | undefined>;
}

function unavailableParent(): DomainResult<never> {
  return domainFailure("storage_unavailable", "Parent request state is unavailable.", true);
}

function unavailableContext(): DomainResult<never> {
  return domainFailure("storage_unavailable", "Context delivery state is unavailable.", true);
}

async function classifyAdmission(
  requests: ContextAdmissionParentRequestPort | undefined,
  fencingToken: FencingToken,
  workspaceKey: WorkspaceKey,
  current: ContextAdmissionMetadata | undefined,
  abort: AbortSignal,
  deadlineMs: number,
): Promise<DomainResult<ContextAdmissionMetadata>> {
  if (!current) return domainFailure("state_conflict", "Context delivery state was lost.", false);
  if (current.state === "context_admitted") return { ok: true, value: current };
  if (current.kind === "message" && current.state === "failed") {
    return domainFailure("target_idle", "Target became idle before context delivery.", true);
  }
  if (current.kind === "message" && current.state === "cancelled") {
    return domainFailure("deadline_expired", "Context delivery was cancelled.", false);
  }
  if (current.kind === "request" && (current.state === "failed" || current.state === "cancelled")) {
    if (!requests) return unavailableParent();
    const parentRead = await boundedExternalCall(
      () =>
        requests.getRequestMetadata({
          fencingToken,
          workspaceKey,
          requestId: current.id as RequestId,
        }),
      abort,
      deadlineMs,
    );
    if (parentRead.kind !== "value") return unavailableParent();
    const parent = parentRead.value;
    if (
      !isCoherentRequestMetadata(parent) ||
      parent.id !== current.id ||
      parent.workspaceKey !== workspaceKey ||
      current.workspaceKey !== workspaceKey ||
      parent.sourceSessionId !== current.sourceSessionId ||
      parent.targetSessionId !== current.targetSessionId ||
      parent.deliveryMode !== "context" ||
      parent.resolutionState === "pending"
    ) {
      return unavailableParent();
    }
    return terminalRequestFailure(parent);
  }
  return domainFailure("admission_unknown", "Context delivery could not be classified.", false);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: deadline cancellation and authoritative reconciliation form one ordered race boundary.
export async function waitForContextAdmission(
  ports: {
    readonly contexts: ContextAdmissionPersistencePort;
    readonly requests?: ContextAdmissionParentRequestPort;
  },
  input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly admission: ContextAdmissionMetadata;
    readonly registration: ContextAdmissionRegistration;
    readonly abort: AbortSignal;
    readonly deadlineMs?: number;
  },
): Promise<DomainResult<ContextAdmissionMetadata>> {
  const foregroundDeadline = (): number =>
    input.deadlineMs ?? Date.now() + contextAdmissionIoTimeoutMs;
  const read = (abort: AbortSignal, deadlineMs: number) =>
    boundedExternalCall(
      () =>
        ports.contexts.getContextAdmission({
          fencingToken: input.fencingToken,
          workspaceKey: input.workspaceKey,
          id: input.admission.id,
        }),
      abort,
      deadlineMs,
    );
  try {
    const initial = await read(input.abort, foregroundDeadline());
    if (initial.kind === "rejected") return unavailableContext();
    let classificationAbort = input.abort;
    let classificationDeadline = foregroundDeadline();
    let current = initial.kind === "value" ? initial.value : input.admission;
    if (initial.kind === "expired") {
      classificationAbort = new AbortController().signal;
      classificationDeadline = Date.now() + contextAdmissionIoTimeoutMs;
      const cleanupRead = await read(classificationAbort, classificationDeadline);
      if (cleanupRead.kind !== "value") return unavailableContext();
      current = cleanupRead.value;
    }
    if (current?.state === "awaiting_context" || current?.state === "prepared") {
      const settlement =
        initial.kind === "expired"
          ? { kind: "expired" as const }
          : input.deadlineMs === undefined
            ? await Promise.resolve(input.registration.outcome).then(
                () => ({ kind: "value" as const }),
                () => ({ kind: "rejected" as const }),
              )
            : await boundedExternalCall(
                () => input.registration.outcome,
                input.abort,
                input.deadlineMs,
              );
      if (settlement.kind === "expired") {
        const cleanupAbort =
          initial.kind === "expired" ? classificationAbort : new AbortController().signal;
        const cleanupDeadline =
          initial.kind === "expired"
            ? classificationDeadline
            : Date.now() + contextAdmissionIoTimeoutMs;
        const cancellationCall = await boundedExternalCall(
          () =>
            ports.contexts.cancelContextAdmission({
              fencingToken: input.fencingToken,
              workspaceKey: input.workspaceKey,
              id: input.admission.id,
            }),
          cleanupAbort,
          cleanupDeadline,
        );
        if (cancellationCall.kind !== "value") return unavailableContext();
        const cancellation = cancellationCall.value;
        const reconciled = await read(cleanupAbort, cleanupDeadline);
        if (reconciled.kind !== "value") return unavailableContext();
        current = reconciled.value;
        if (current?.state === "context_admitted") return { ok: true, value: current };
        if (current?.state === "cancelled" && cancellation.ok) {
          return domainFailure("deadline_expired", "Context delivery deadline elapsed.", false);
        }
        return classifyAdmission(
          ports.requests,
          input.fencingToken,
          input.workspaceKey,
          current,
          cleanupAbort,
          cleanupDeadline,
        );
      }
      if (settlement.kind === "rejected") {
        return domainFailure("storage_unavailable", "Context delivery state is unavailable.", true);
      }
      const finalRead = await read(input.abort, foregroundDeadline());
      if (finalRead.kind !== "value") return unavailableContext();
      current = finalRead.value;
    }
    return classifyAdmission(
      ports.requests,
      input.fencingToken,
      input.workspaceKey,
      current,
      classificationAbort,
      classificationDeadline,
    );
  } catch {
    return domainFailure("storage_unavailable", "Context delivery state is unavailable.", true);
  } finally {
    input.registration.detach();
  }
}
