import type { ContextAdmissionMetadata } from "../domain/context-admissions";
import {
  digestMessageContent,
  type Sha256Digest,
  serializeVerifiedMessageEnvelope,
} from "../domain/message-payload";
import { type DomainResult, domainFailure } from "../domain/results";
import { sanitizeDisplayTitle } from "../domain/sanitize-display";
import { runUntilAborted } from "./abortable-operation";
import {
  communicatorLifecycleFencingToken,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type { ContextAdmissionRegistration } from "./context-admission-runtime";
import { inspectMessageAuthorizationDecision } from "./delivery-ports";
import {
  ParticipantOperationAbortedFault,
  ParticipantOperationCapacityFault,
} from "./participant-operation-gate";
import type { SessionSendContext, SessionSendPorts } from "./session-message-delivery-contracts";
import { readSessionSendMembership } from "./session-message-membership";
import { sendVisibilityFailure, type ValidatedSendInput } from "./session-send-validation";
import { waitForContextAdmission } from "./wait-for-context-admission";

function unavailable(): DomainResult<never> {
  return domainFailure("storage_unavailable", "Context delivery is unavailable.", true);
}

function participantOperationFailure(cause: unknown): DomainResult<never> {
  if (cause instanceof ParticipantOperationAbortedFault) {
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (cause instanceof ParticipantOperationCapacityFault) {
    return domainFailure("quota_exceeded", "Participant operation capacity is exhausted.", false);
  }
  return unavailable();
}

async function authorizeContextMessage(
  ports: SessionSendPorts,
  context: SessionSendContext,
  input: ValidatedSendInput,
  contentSha256: Sha256Digest,
): Promise<DomainResult<undefined>> {
  const authorization = await runUntilAborted(context.abort, () =>
    ports.authorization.authorizeMessage(
      {
        workspaceKey: context.workspaceKey,
        sourceSessionId: context.sourceSessionId,
        targetSessionId: input.target,
        operation: "message",
        contentSha256,
        contentByteLength: input.byteLength,
      },
      {
        abort: context.abort,
        ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
      },
    ),
  );
  if (authorization.kind === "aborted") {
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (authorization.kind !== "settled") return unavailable();
  const decision = inspectMessageAuthorizationDecision(authorization.value);
  if (!decision) return unavailable();
  if (decision.kind === "deny") {
    return domainFailure("permission_denied", "Message permission was denied.", false);
  }
  if (decision.kind === "approval_rejected") {
    return domainFailure("approval_rejected", "Message approval was rejected.", false);
  }
  return { ok: true, value: undefined };
}

export async function sendContextSessionMessage(
  ports: SessionSendPorts,
  context: SessionSendContext,
  input: ValidatedSendInput,
): Promise<DomainResult<ContextAdmissionMetadata>> {
  if (!ports.contexts || !ports.contextRuntime || !ports.activity || !ports.participantOperations) {
    return unavailable();
  }
  const contexts = ports.contexts;
  const runtime = ports.contextRuntime;
  const activity = ports.activity;
  const participantOperations = ports.participantOperations;
  const membership = await readSessionSendMembership(ports, context, input.target);
  if (!membership.ok) return membership;
  const visibility = sendVisibilityFailure(membership.value);
  if (visibility) return visibility;
  const deliveryId = ports.ids.deliveryId();
  const digest = await runUntilAborted(context.abort, () =>
    digestMessageContent(ports.digest, input.bytes),
  );
  if (digest.kind === "aborted") {
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (digest.kind !== "settled") return unavailable();
  const authorized = await authorizeContextMessage(ports, context, input, digest.value);
  if (!authorized.ok) return authorized;
  const envelopeJson = serializeVerifiedMessageEnvelope({
    sourceSessionId: context.sourceSessionId,
    targetSessionId: input.target,
    workspaceKey: context.workspaceKey,
    deliveryId,
    content: input.content,
    sourceTitle: sanitizeDisplayTitle(membership.value.sourceTitle ?? ""),
  });
  const envelopeBytes = new TextEncoder().encode(envelopeJson);
  const envelopeDigest = await runUntilAborted(context.abort, () =>
    digestMessageContent(ports.digest, envelopeBytes),
  );
  if (envelopeDigest.kind !== "settled") return unavailable();
  let registration: ContextAdmissionRegistration;
  try {
    registration = runtime.attach({
      id: deliveryId,
      kind: "message",
      sourceSessionId: context.sourceSessionId,
      workspaceKey: context.workspaceKey,
    });
  } catch {
    return domainFailure("quota_exceeded", "Context delivery waiter capacity is exhausted.", false);
  }
  const fencingToken = communicatorLifecycleFencingToken(ports.readiness);
  let persisted: Awaited<ReturnType<typeof contexts.createContextMessage>>;
  try {
    const gated = await participantOperations.run(
      [context.sourceSessionId, input.target],
      context.abort,
      async () => {
        const observed = await activity.observeRequestParticipants(
          context.workspaceKey,
          context.sourceSessionId,
          input.target,
          context.abort,
        );
        if (!observed.sourceVisible) {
          return domainFailure(
            "caller_not_visible",
            "Caller is not a current visible root session.",
            false,
          );
        }
        if (!observed.targetVisible) {
          return domainFailure(
            "target_not_visible",
            "Target is not a current visible root session.",
            false,
          );
        }
        if (observed.targetStatus === "idle") {
          return domainFailure(
            "target_idle",
            "Target is idle; use delivery: user to wake it.",
            true,
          );
        }
        if (observed.targetStatus !== "busy" && observed.targetStatus !== "retry") {
          return domainFailure("target_status_unknown", "Target activity is unknown.", true);
        }
        if ((await ports.ownership.isCurrent(fencingToken)) !== true) {
          stopCommunicatorForOwnershipLoss(ports.readiness);
          return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
        }
        return contexts.createContextMessage({
          fencingToken,
          id: deliveryId,
          workspaceKey: context.workspaceKey,
          sourceSessionId: context.sourceSessionId,
          targetSessionId: input.target,
          envelopeJson,
          contentByteLength: envelopeBytes.length,
          contentSha256: envelopeDigest.value,
          createdAtMs: ports.clock.nowMs(),
        });
      },
    );
    if ("ok" in gated && gated.ok === false && "error" in gated) {
      registration.detach();
      return gated;
    }
    persisted = gated as Awaited<ReturnType<typeof contexts.createContextMessage>>;
  } catch (cause: unknown) {
    registration.detach();
    return participantOperationFailure(cause);
  }
  if (!persisted.ok) {
    registration.detach();
    return persisted.code === "quota_exceeded" || persisted.code === "rate_limited"
      ? domainFailure(persisted.code, "Context delivery capacity is exhausted.", true)
      : unavailable();
  }
  return waitForContextAdmission(
    { contexts },
    {
      fencingToken,
      workspaceKey: context.workspaceKey,
      admission: persisted.admission,
      registration,
      abort: context.abort,
      ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
    },
  );
}
