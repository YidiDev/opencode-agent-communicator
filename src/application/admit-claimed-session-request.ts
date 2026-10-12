import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../domain/request-identity";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import {
  completionInput,
  dataRecord,
  expectedCommitted,
  inspectNativeAdmission,
  publicAdmissionOutcome,
  requestAdmissionFailure,
  validAdmissionInput,
} from "./claimed-request-admission-boundaries";
import type {
  ClockPort,
  NativeQueueAdmissionPort,
  OperationControl,
  OwnershipPort,
} from "./delivery-ports";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import {
  type NativeSteerAdmission,
  type NativeSteerAdmissionPort,
  type RequestAdmissionPersistencePort,
  type RequestStoreFailureCode,
  requestStoreFailureCodes,
} from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { operationControlStopped } from "./safe-clock";
import { createLinkedEffectControl } from "./startup-effect-control";

export interface ClaimedSessionRequestAdmissionPorts {
  readonly requests: RequestAdmissionPersistencePort;
  readonly nativeSteer: NativeSteerAdmissionPort;
  readonly nativeQueue?: NativeQueueAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly clock: ClockPort;
}

export type ClaimedSessionRequestAdmissionOutcome = Readonly<{
  readonly outcome: "delivery_unknown" | "delivery_failed" | "admitted" | "promoted";
  readonly request: RequestMetadata;
}>;

export interface ClaimedSessionRequestAdmissionInput {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: FencingToken;
  readonly request: RequestMetadata & { readonly deliveryState: "submitting" };
  readonly envelope: string;
  readonly control: OperationControl;
  /** Process-lifecycle signal for the external effect; it is never a request cancellation. */
  readonly effectSignal: AbortSignal;
  /** Blocking invocations classify caller-aborted in-flight transport as durable ambiguity. */
  readonly callerAbortPersistsUnknown?: boolean;
}

const failure = requestAdmissionFailure;

function isStoreFailureCode(value: unknown): value is RequestStoreFailureCode {
  return typeof value === "string" && requestStoreFailureCodes.some((code) => code === value);
}

function stopped(ports: ClaimedSessionRequestAdmissionPorts, control: OperationControl): boolean {
  return operationControlStopped(ports.clock, control.abort, control.deadlineMs);
}

async function performNativeSteer(
  ports: ClaimedSessionRequestAdmissionPorts,
  input: ClaimedSessionRequestAdmissionInput,
  signal: AbortSignal,
): Promise<NativeSteerAdmission | undefined> {
  if (signal.aborted) return undefined;
  const nativeQueue = ports.nativeQueue;
  try {
    let submit: () => Promise<NativeSteerAdmission>;
    if (input.request.deliveryMode === "queue") {
      submit = () =>
        (nativeQueue as NativeQueueAdmissionPort)
          .queueMessage({
            targetSessionId: input.request.targetSessionId,
            nativeMessageId: input.request.nativeMessageId,
            envelope: input.envelope,
            abort: signal,
          })
          .then((value) =>
            value.kind === "public_message" ? { kind: "unknown" as const } : value,
          );
    } else {
      submit = () =>
        ports.nativeSteer.steerRequest({
          targetSessionId: input.request.targetSessionId,
          nativeMessageId: input.request.nativeMessageId,
          envelope: input.envelope,
          abort: signal,
        });
    }
    const settlement = await runUntilAborted(signal, submit);
    if (settlement.kind === "aborted") return undefined;
    if (settlement.kind === "rejected" && settlement.cause instanceof OwnershipLostFault) {
      return undefined;
    }
    return settlement.kind === "settled"
      ? inspectNativeAdmission(settlement.value)
      : { kind: "unknown" };
  } catch {
    return signal.aborted ? undefined : { kind: "unknown" };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear admission boundary keeps interruption, fencing, effect, and exact committed-state checks auditable.
async function admitClaimedSessionRequestInternal(
  ports: ClaimedSessionRequestAdmissionPorts,
  input: ClaimedSessionRequestAdmissionInput,
): Promise<DomainResult<ClaimedSessionRequestAdmissionOutcome>> {
  if (!validAdmissionInput(input)) {
    return domainFailure("state_conflict", "Claimed request admission input is malformed.", false);
  }
  if (input.request.deliveryMode === "queue" && !ports.nativeQueue) {
    return failure("storage_unavailable");
  }
  if (input.effectSignal.aborted) return failure("ownership_lost");
  if (stopped(ports, input.control) && input.callerAbortPersistsUnknown !== true)
    return failure("ownership_lost");
  const current = await runUntilAborted(input.effectSignal, () =>
    ports.ownership.isCurrent(input.fencingToken),
  );
  if (current.kind === "aborted") return failure("ownership_lost");
  if (current.kind === "rejected") {
    return failure(
      current.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
  if (current.value !== true) return failure("ownership_lost");
  // No awaited work may occur between this final startup-control check and the single native effect.
  if (input.effectSignal.aborted) return failure("ownership_lost");
  const abortedBeforeNative = stopped(ports, input.control);
  if (abortedBeforeNative && input.callerAbortPersistsUnknown !== true)
    return failure("ownership_lost");
  const linked = createLinkedEffectControl({
    signals: [input.control.abort, input.effectSignal],
    ...(input.control.deadlineMs === undefined ? {} : { deadlineMs: input.control.deadlineMs }),
    clock: ports.clock,
  });
  if (!linked) return failure("ownership_lost");
  let native: NativeSteerAdmission | undefined;
  try {
    native = abortedBeforeNative
      ? { kind: "unknown" }
      : await performNativeSteer(ports, input, linked.signal);
  } finally {
    linked.dispose();
  }
  if (!native) {
    if (
      input.callerAbortPersistsUnknown === true &&
      input.control.abort.aborted &&
      !input.effectSignal.aborted
    ) {
      native = { kind: "unknown" };
    } else {
      return failure("ownership_lost");
    }
  }
  // An interrupted effect is ambiguous. Keep submitting for a successor; never persist rejection.
  if (input.effectSignal.aborted) return failure("ownership_lost");
  if (stopped(ports, input.control) && !input.control.abort.aborted)
    return failure("ownership_lost");
  const currentAfterEffect = await runUntilAborted(input.effectSignal, () =>
    ports.ownership.isCurrent(input.fencingToken),
  );
  if (currentAfterEffect.kind === "aborted") {
    return failure("ownership_lost");
  }
  if (currentAfterEffect.kind === "rejected") {
    return failure(
      currentAfterEffect.cause instanceof OwnershipLostFault
        ? "ownership_lost"
        : "storage_unavailable",
    );
  }
  if (currentAfterEffect.value !== true) return failure("ownership_lost");
  let raw: unknown;
  try {
    const settlement = await runUntilAborted(input.effectSignal, () =>
      ports.requests.completeDelivery(completionInput(input, native)),
    );
    if (settlement.kind === "aborted") return failure("ownership_lost");
    if (settlement.kind === "rejected") {
      return failure(
        settlement.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      );
    }
    raw = settlement.value;
  } catch (cause: unknown) {
    return failure(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable");
  }
  const failed = dataRecord(raw, ["ok", "code"]);
  if (failed?.ok === false) {
    if (!isStoreFailureCode(failed.code)) {
      return failure("storage_unavailable");
    }
    return failure(failed.code);
  }
  const committed = dataRecord(raw, ["ok", "request"]);
  const committedRequest = inspectRequestMetadata(committed?.request);
  if (
    committed?.ok !== true ||
    !committedRequest ||
    !hasRequestIdentity(snapshotRequestIdentity(input.request), committedRequest) ||
    !expectedCommitted(native, committedRequest)
  ) {
    return failure("storage_unavailable");
  }
  if (committedRequest.resolutionState !== "pending") {
    notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(committedRequest));
  }
  const outcome = publicAdmissionOutcome(native);
  return { ok: true, value: Object.freeze({ outcome, request: committedRequest }) };
}

export async function admitClaimedSessionRequest(
  ports: ClaimedSessionRequestAdmissionPorts,
  input: ClaimedSessionRequestAdmissionInput,
): Promise<DomainResult<ClaimedSessionRequestAdmissionOutcome>> {
  try {
    return await admitClaimedSessionRequestInternal(ports, input);
  } catch {
    return domainFailure("storage_unavailable", "Claimed request admission failed safely.", true);
  }
}
