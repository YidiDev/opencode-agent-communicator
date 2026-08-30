import type { Sha256DigestPort } from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import { isCoherentStartOperation, type StartOperation } from "../domain/session-start";
import type { WorkspaceKey } from "../domain/workspaces";
import type { ClockPort, CurrentWorkspaceMembershipPort, OwnershipPort } from "./delivery-ports";
import type { RequestAdmissionPersistencePort } from "./request-ports";
import type { SessionStartPorts } from "./session-start-application";
import type {
  NativeSessionStartPort,
  SessionRequestStartPersistencePort,
  StartOperationPersistencePort,
} from "./session-start-ports";
import { executeStartEffects } from "./start-session";
import { claimForEffect } from "./start-session-effect-preparation";
import { runStartCreation, runStartTitle } from "./start-session-effects";

export interface SessionStartRecoveryInput {
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
  readonly limit?: number;
  readonly abort?: AbortSignal;
  readonly nativeStart?: NativeSessionStartPort;
  readonly requestStarts?: SessionRequestStartPersistencePort;
  readonly requests?: RequestAdmissionPersistencePort;
  readonly membership?: CurrentWorkspaceMembershipPort;
  readonly ownership?: OwnershipPort;
  readonly digest?: Sha256DigestPort;
}

async function finishAmbiguousInitialStart(
  ports: SessionStartPorts,
  clock: ClockPort,
  input: SessionStartRecoveryInput,
  operation: StartOperation,
): Promise<void> {
  const context = {
    workspaceKey: input.workspaceKey,
    sourceSessionId: operation.sourceSessionId,
    abort: input.abort ?? new AbortController().signal,
    deadlineMs: Number.MAX_SAFE_INTEGER,
  };
  const creation = await runStartCreation(ports, context, input.fencingToken, operation);
  if (!creation.ok || creation.value.creationState !== "created") return;
  const title = await runStartTitle(ports, context, input.fencingToken, creation.value);
  if (!title.ok || title.value.admissionState !== "prepared") return;
  const claimed = await claimForEffect(
    ports,
    context,
    input.fencingToken,
    title.value,
    "admission",
  );
  if (!claimed.ok) throw new Error("Ambiguous linked initial admission could not be claimed.");
  const completed = await ports.starts.completeAdmission({
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    operationId: operation.id,
    state: "admission_unknown",
    nowMs: clock.nowMs(),
  });
  if (!completed.ok) throw new Error("Ambiguous linked initial admission could not be committed.");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linked initial-request recovery intentionally keeps claim, start effect, and one terminal delivery commit linear.
export async function resumePreparedInitialRequest(
  starts: StartOperationPersistencePort,
  clock: ClockPort,
  input: SessionStartRecoveryInput,
  operation: StartOperation,
): Promise<boolean> {
  if (
    !input.requestStarts?.readSessionRequestStartByOperation ||
    !input.requests ||
    !input.membership ||
    !input.ownership ||
    !input.digest ||
    !input.nativeStart
  ) {
    return false;
  }
  const linked = await input.requestStarts.readSessionRequestStartByOperation({
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    operationId: operation.id,
  });
  if (!linked) return false;
  const effectPorts = {
    readiness: { fencingToken: input.fencingToken, assertReady() {} },
    membership: input.membership,
    starts,
    nativeStart: input.nativeStart,
    ownership: input.ownership,
    clock,
    digest: input.digest,
  } as unknown as SessionStartPorts;
  if (linked.request.resolutionState !== "pending") return true;
  if (linked.request.deliveryState === "delivery_unknown") {
    await finishAmbiguousInitialStart(effectPorts, clock, input, operation);
    return true;
  }
  if (
    linked.request.deliveryState !== "prepared" &&
    linked.request.deliveryState !== "submitting"
  ) {
    return true;
  }
  let claimedRequest = linked.request;
  if (linked.request.deliveryState === "prepared") {
    const claimed = await input.requests.claimPrepared({
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      requestId: linked.request.id,
    });
    if (!claimed.ok) throw new Error("Linked initial request recovery could not be claimed.");
    if (
      claimed.request.resolutionState !== "pending" ||
      claimed.request.deliveryState !== "submitting"
    ) {
      return true;
    }
    claimedRequest = claimed.request;
  }
  if (operation.admissionState === "admission_unknown") {
    const settled = await input.requests.completeDelivery({
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      requestId: claimedRequest.id,
      outcome: "delivery_unknown",
    });
    if (!settled.ok) throw new Error("Ambiguous linked initial request could not be completed.");
    return true;
  }
  if (operation.admissionState === "admitted" || operation.admissionState === "failed") {
    const base = {
      fencingToken: input.fencingToken,
      workspaceKey: input.workspaceKey,
      requestId: claimedRequest.id,
    };
    const settled = await input.requests.completeDelivery(
      operation.admissionState === "admitted"
        ? {
            ...base,
            outcome: "admitted",
            nativeMessageId: claimedRequest.nativeMessageId,
            admittedSeq: 0,
            evidenceObservedAtMs: clock.nowMs(),
          }
        : { ...base, outcome: "delivery_failed" },
    );
    if (!settled.ok) throw new Error("Definitive linked initial request could not be completed.");
    return true;
  }
  const result = await executeStartEffects(
    effectPorts,
    {
      workspaceKey: input.workspaceKey,
      sourceSessionId: operation.sourceSessionId,
      abort: input.abort ?? new AbortController().signal,
      deadlineMs: Number.MAX_SAFE_INTEGER,
    },
    input.fencingToken,
    operation,
  );
  const completed = result.ok
    ? result.value
    : isCoherentStartOperation(result.error.details?.operation)
      ? result.error.details.operation
      : operation;
  const base = {
    fencingToken: input.fencingToken,
    workspaceKey: input.workspaceKey,
    requestId: claimedRequest.id,
  };
  const outcome =
    completed.admissionState === "admitted"
      ? {
          ...base,
          outcome: "admitted" as const,
          nativeMessageId: claimedRequest.nativeMessageId,
          admittedSeq: 0,
          evidenceObservedAtMs: clock.nowMs(),
        }
      : completed.admissionState === "failed" || completed.creationState === "failed"
        ? { ...base, outcome: "delivery_failed" as const }
        : { ...base, outcome: "delivery_unknown" as const };
  const settled = await input.requests.completeDelivery(outcome);
  if (!settled.ok) throw new Error("Linked initial request recovery could not be completed.");
  return true;
}
