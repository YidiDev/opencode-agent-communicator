import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import { canonicalizeSerializeAndDigestPendingRequestPayload } from "../domain/request-serialization";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { isCoherentStartOperation, type StartOperation } from "../domain/session-start";
import { wakeRequestScheduler } from "./blocking-request-creation-preconditions";
import {
  assertCommunicatorReady,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type {
  SessionRequestStartArguments,
  SessionRequestStartPorts,
  SessionRequestStartResult,
} from "./session-request-start-application";
import {
  digestPublicArguments,
  prepareAuthorizedComposite,
  settleInitialRequest,
} from "./session-request-start-preparation";
import type { SessionStartContext } from "./session-start-application";
import type {
  SessionRequestStartPersistencePort,
  StartStoreFailureCode,
} from "./session-start-ports";
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

export type {
  SessionRequestStartArguments,
  SessionRequestStartPorts,
  SessionRequestStartResult,
} from "./session-request-start-application";

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
        context.abort,
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
    if (!reconciled.ok) {
      if (reconciled.error.code !== "native_outcome_unknown") return reconciled;
      return domainFailure(
        reconciled.error.code,
        reconciled.error.message,
        reconciled.error.retryable,
        { operation: prepared.operation, request: prepared.request },
      );
    }
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
