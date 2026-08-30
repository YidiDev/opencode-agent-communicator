import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../domain/generated-ids";
import { digestMessageContent } from "../domain/message-payload";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  serializeVerifiedRequestEnvelope,
} from "../domain/request-serialization";
import type {
  PendingRequestMetadata,
  PendingRequestPayload,
  RequestMetadata,
} from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import {
  digestStartArguments,
  isCoherentStartOperation,
  type StartOperation,
  type ValidatedStartArguments,
} from "../domain/session-start";
import { wakeRequestScheduler } from "./blocking-request-creation-preconditions";
import type { RequestDeadlineWakePort } from "./blocking-session-request-boundaries";
import {
  assertCommunicatorReady,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type { RequestAuthorizationPort } from "./request-authorization-port";
import type { RequestAdmissionPersistencePort } from "./request-ports";
import type {
  SessionRequestStartPersistencePort,
  StartStoreFailureCode,
} from "./session-start-ports";
import type {
  SessionStartArguments,
  SessionStartContext,
  SessionStartPorts,
} from "./start-session";
import {
  acquireSessionStartToken,
  executeStartEffects,
  sessionStartCallerVisible,
  sessionStartPolicyFailure,
  sessionStartRecursionAllowed,
  validateSessionStartArguments,
  validSessionStartControl,
} from "./start-session";
import {
  reconcileStartCreation,
  StartEffectContractFault,
  startStoreFailure,
} from "./start-session-effects";

export interface SessionRequestStartArguments extends SessionStartArguments {
  readonly initial_message: string;
  readonly request: PendingRequestPayload;
}

export interface SessionRequestStartPorts extends SessionStartPorts {
  readonly requests: RequestAdmissionPersistencePort;
  readonly requestStarts: SessionRequestStartPersistencePort;
  readonly requestAuthorization: RequestAuthorizationPort;
  readonly scheduler: RequestDeadlineWakePort;
}

export interface SessionRequestStartResult {
  readonly operation: StartOperation;
  readonly request: RequestMetadata;
}

function requestIdFor(operationId: string) {
  const checked = validateRequestId(`req_${operationId.slice(3)}`);
  if (!checked.ok) throw new StartEffectContractFault("Operation could not bind a request ID.");
  return checked.value;
}

async function digestPublicArguments(
  ports: SessionRequestStartPorts,
  args: SessionRequestStartArguments,
  payloadJson: string,
) {
  return digestMessageContent(
    ports.digest,
    new TextEncoder().encode(
      JSON.stringify({
        domain: "opencode-session-communicator/session_request_start/arguments/v1",
        idempotency_key: args.idempotency_key,
        initial_message: args.initial_message,
        title: args.title ?? null,
        agent: args.agent ?? null,
        model: args.model ?? null,
        request: JSON.parse(payloadJson),
      }),
    ),
  );
}

async function approveCompositeStart(
  ports: SessionRequestStartPorts,
  context: SessionStartContext,
  argumentsSha256: StartOperation["argumentsSha256"],
): Promise<DomainResult<true>> {
  if (ports.policy.decision === "deny") {
    return domainFailure("permission_denied", "Session start is denied by policy.", false);
  }
  if (ports.policy.decision === "allow") return { ok: true, value: true };
  const approval = await ports.approval.requestStartApproval(
    {
      workspaceKey: context.workspaceKey,
      sourceSessionId: context.sourceSessionId,
      argumentsSha256,
    },
    { abort: context.abort, deadlineMs: context.deadlineMs },
  );
  if (approval !== "approved" && approval !== "rejected") {
    throw new StartEffectContractFault("The start approval adapter returned an unknown outcome.");
  }
  return approval === "approved"
    ? { ok: true, value: true }
    : domainFailure("approval_rejected", "Session start approval was rejected.", false);
}

async function settleInitialRequest(
  ports: SessionRequestStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
  request: RequestMetadata,
): Promise<DomainResult<RequestMetadata>> {
  if (request.deliveryState !== "submitting") return { ok: true, value: request };
  const base = {
    fencingToken: token,
    workspaceKey: context.workspaceKey,
    requestId: request.id,
  };
  const outcome =
    operation.admissionState === "admitted"
      ? {
          ...base,
          outcome: "admitted" as const,
          nativeMessageId: request.nativeMessageId,
          admittedSeq: 0,
          evidenceObservedAtMs: ports.clock.nowMs(),
        }
      : operation.admissionState === "failed"
        ? { ...base, outcome: "delivery_failed" as const }
        : { ...base, outcome: "delivery_unknown" as const };
  try {
    const settled = await ports.requests.completeDelivery(outcome);
    return settled.ok
      ? { ok: true, value: settled.request }
      : domainFailure("storage_unavailable", "Linked request settlement failed.", true, {
          operation,
          request,
        });
  } catch {
    return domainFailure("storage_unavailable", "Linked request settlement failed.", true, {
      operation,
      request,
    });
  }
}

type CanonicalPendingPayload = Extract<
  Awaited<ReturnType<typeof canonicalizeSerializeAndDigestPendingRequestPayload>>,
  { readonly ok: true }
>;

async function prepareAuthorizedComposite(
  ports: SessionRequestStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  validated: ValidatedStartArguments,
  payload: CanonicalPendingPayload,
  idempotencyArgumentsSha256: StartOperation["argumentsSha256"],
): Promise<DomainResult<SessionRequestStartResult>> {
  const generated = {
    operationId: ports.ids.startOperationId(),
    sessionId: ports.ids.managedSessionId(),
    nativeMessageId: ports.ids.nativeMessageId(),
  };
  if (
    !validateStartOperationId(generated.operationId).ok ||
    !validateManagedSessionId(generated.sessionId).ok ||
    !validateNativeMessageId(generated.nativeMessageId).ok
  ) {
    throw new StartEffectContractFault("Generated request-start identifiers are malformed.");
  }
  const requestId = requestIdFor(generated.operationId);
  const createdAtMs = ports.clock.nowMs();
  const deadlineAtMs = createdAtMs + payload.value.timeoutSeconds * 1_000;
  const authorization = await ports.requestAuthorization.authorizeRequest(
    {
      workspaceKey: context.workspaceKey,
      sourceSessionId: context.sourceSessionId,
      targetSessionId: generated.sessionId,
      operation: payload.value.kind,
      payloadSha256: payload.sha256,
      payloadByteLength: payload.byteLength,
      timeoutSeconds: payload.value.timeoutSeconds,
      createdAtMs,
      deadlineAtMs,
    },
    { abort: context.abort, deadlineMs: context.deadlineMs },
  );
  if (authorization.kind === "deny")
    return domainFailure("permission_denied", "Request permission was denied.", false);
  if (authorization.kind !== "allow")
    return domainFailure("approval_rejected", "Request approval was rejected.", false);
  const approval = await approveCompositeStart(ports, context, idempotencyArgumentsSha256);
  if (!approval.ok) return approval;
  const workBytes = new TextEncoder().encode(validated.initialMessage);
  const pending: PendingRequestMetadata & { readonly deliveryState: "prepared" } = {
    id: requestId,
    workspaceKey: context.workspaceKey,
    sourceSessionId: context.sourceSessionId,
    targetSessionId: generated.sessionId,
    nativeMessageId: generated.nativeMessageId,
    deliveryMode: "initial",
    linkedStartOperationId: generated.operationId,
    kind: payload.value.kind,
    resolutionState: "pending",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: payload.byteLength,
    payloadSha256: payload.sha256,
    createdAtMs,
    updatedAtMs: createdAtMs,
    deadlineAtMs,
  };
  let envelope: string;
  try {
    envelope = await serializeVerifiedRequestEnvelope(
      {
        ...pending,
        requestId,
        payload: payload.value,
        work: {
          content: validated.initialMessage,
          byteLength: workBytes.length,
          sha256: await digestMessageContent(ports.digest, workBytes),
        },
      },
      ports.digest,
    );
  } catch (cause: unknown) {
    if (cause instanceof RangeError) {
      return domainFailure(
        "invalid_arguments",
        "Combined work and request content exceeds the request envelope limit.",
        false,
      );
    }
    throw cause;
  }
  const storedStartArguments = { ...validated, initialMessage: envelope };
  const argumentsSha256 = await digestStartArguments(ports.digest, storedStartArguments);
  try {
    const persisted = await ports.requestStarts.createOrResumeSessionRequestStart({
      start: {
        fencingToken: token,
        workspaceKey: context.workspaceKey,
        sourceSessionId: context.sourceSessionId,
        ...generated,
        argumentsSha256,
        idempotencyArgumentsSha256,
        arguments: storedStartArguments,
        limits: ports.policy.limits,
        nowMs: createdAtMs,
      },
      request: {
        fencingToken: token,
        creationOperationId: generated.operationId,
        deliveryMode: "initial",
        linkedStartOperationId: generated.operationId,
        request: pending,
        payloadJson: payload.serialized,
        envelopeJson: envelope,
      },
    });
    if (persisted.ok) return { ok: true, value: persisted };
    if (persisted.code === "deadlock_detected") {
      return domainFailure(
        "deadlock_detected",
        "The linked request would create a wait cycle.",
        false,
      );
    }
    return startStoreFailure(persisted.code as StartStoreFailureCode);
  } catch (cause: unknown) {
    return startStoreFailure(
      cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every authorization, durability, and native-effect boundary is intentionally explicit.
export async function startSessionRequest(
  ports: SessionRequestStartPorts,
  context: SessionStartContext & { readonly fencingToken: FencingToken },
  args: SessionRequestStartArguments,
): Promise<DomainResult<SessionRequestStartResult>> {
  assertCommunicatorReady(ports.readiness);
  const validated = validateSessionStartArguments(args);
  if (!validated.ok) return validated;
  const denied = sessionStartPolicyFailure(ports.policy, validated.value);
  if (denied) return denied;
  const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(
    ports.digest,
    args.request,
  );
  if (!payload.ok) return domainFailure("invalid_arguments", payload.message, false);
  const control = validSessionStartControl(ports, context);
  if (!control)
    return domainFailure("invalid_arguments", "Session-start deadline control is invalid.", false);
  const linkedContext = { ...context, abort: control.signal };
  try {
    const visible = await sessionStartCallerVisible(ports, linkedContext);
    if (!visible.ok) return visible;
    const token = await acquireSessionStartToken(ports);
    if (!token.ok) return token;
    try {
      if ((await ports.ownership.isCurrent(token.value)) !== true) {
        stopCommunicatorForOwnershipLoss(ports.readiness);
        return startStoreFailure("ownership_lost");
      }
    } catch {
      stopCommunicatorForOwnershipLoss(ports.readiness);
      return startStoreFailure("ownership_lost");
    }
    const recursion = await sessionStartRecursionAllowed(ports, linkedContext, token.value);
    if (!recursion.ok) return recursion;

    const idempotencyArgumentsSha256 = await digestPublicArguments(ports, args, payload.serialized);
    let existing: Awaited<
      ReturnType<SessionRequestStartPersistencePort["readSessionRequestStart"]>
    >;
    try {
      existing = await ports.requestStarts.readSessionRequestStart({
        fencingToken: token.value,
        workspaceKey: context.workspaceKey,
        sourceSessionId: context.sourceSessionId,
        idempotencyKey: validated.value.idempotencyKey,
        idempotencyArgumentsSha256,
      });
    } catch (cause: unknown) {
      return startStoreFailure(
        cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      );
    }
    if (!existing.ok) return startStoreFailure(existing.code);
    let prepared: { readonly operation: StartOperation; readonly request: RequestMetadata };
    if (existing.found) {
      prepared = existing;
    } else {
      const created = await prepareAuthorizedComposite(
        ports,
        linkedContext,
        token.value,
        validated.value,
        payload,
        idempotencyArgumentsSha256,
      );
      if (!created.ok) return created;
      prepared = created.value;
    }
    if (
      !isCoherentStartOperation(prepared.operation) ||
      !isCoherentRequestMetadata(prepared.request) ||
      prepared.operation.idempotencyKey !== validated.value.idempotencyKey ||
      prepared.request.linkedStartOperationId !== prepared.operation.id
    ) {
      throw new StartEffectContractFault("Composite persistence returned unrelated state.");
    }
    wakeRequestScheduler(ports.scheduler);

    const reconciled = await reconcileStartCreation(
      ports,
      linkedContext,
      token.value,
      prepared.operation,
    );
    if (!reconciled.ok) return reconciled;
    let request = prepared.request;
    const operation = reconciled.value;
    if (request.resolutionState === "pending" && request.deliveryState === "prepared") {
      const claimed = await ports.requests.claimPrepared({
        fencingToken: token.value,
        workspaceKey: context.workspaceKey,
        requestId: request.id,
      });
      if (!claimed.ok) {
        if (claimed.code === "deadlock_detected") {
          return domainFailure("deadlock_detected", "The linked request claim failed.", false);
        }
        return startStoreFailure(claimed.code as StartStoreFailureCode);
      }
      request = claimed.request;
    }
    const started = await executeStartEffects(ports, linkedContext, token.value, operation);
    if (!started.ok) {
      const failedOperation = isCoherentStartOperation(started.error.details?.operation)
        ? started.error.details.operation
        : operation;
      const settlement = await settleInitialRequest(
        ports,
        context,
        token.value,
        failedOperation,
        request,
      );
      if (!settlement.ok) return settlement;
      request = settlement.value;
      return {
        ok: false,
        error: {
          ...started.error,
          details: { ...(started.error.details ?? {}), operation: failedOperation, request },
        },
      };
    }
    const settlement = await settleInitialRequest(
      ports,
      context,
      token.value,
      started.value,
      request,
    );
    if (!settlement.ok) return settlement;
    request = settlement.value;
    return { ok: true, value: { operation: started.value, request } };
  } finally {
    control.dispose();
  }
}
