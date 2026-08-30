import type { AdvisoryLockPersistencePort } from "../../application/advisory-lock-ports";
import type {
  CompleteSubmissionInput,
  DeliveryClaimResult,
  DeliveryPersistencePort,
  DeliveryStoreResult,
  DeliveryTransitionInput,
  OwnershipPort,
  PrepareDeliveryInput,
  RecoveryStartupBarrierPort,
} from "../../application/delivery-ports";
import type { DeliveryRetentionPersistencePort } from "../../application/delivery-retention";
import type {
  DeleteAbsentParticipantRequestsInput,
  ParticipantDeletionPersistencePort,
} from "../../application/participant-deletion-ports";
import type {
  CompleteRequestDeliveryInput,
  ExpireDueRequestsResult,
  PrepareRequestInput,
  RequestAdmissionPersistencePort,
  RequestClaimReconciliation,
  RequestClaimResult,
  RequestCreationReconciliation,
  RequestDeadlineSchedulePort,
  RequestParticipantQueryPort,
  RequestRecoveryPersistencePort,
  RequestResultRetentionPersistencePort,
  RequestRetentionPersistencePort,
  RequestRetentionResult,
  RequestStoreResult,
  RequestTerminalPersistencePort,
  RequestTransitionInput,
} from "../../application/request-ports";
import type {
  PrepareSessionRequestStartInput,
  SessionRequestStartPersistencePort,
  SessionRequestStartStoreResult,
} from "../../application/session-start-ports";
import type { SessionStopPersistencePort } from "../../application/session-stop-ports";
import type { DeliveryMetadata, DeliveryParticipantRole } from "../../domain/deliveries";
import { validateRequestId } from "../../domain/generated-ids";
import type { FencingToken } from "../../domain/ownership";
import type { SessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import { SqliteStoreCore } from "./sqlite-store-core";
import {
  hydrateStartOperation,
  type StartOperationRow,
  startOperationColumns,
} from "./start-operation-rows";
import type { StoreStorageDiagnostics } from "./store-maintenance-repository";

type CompositeFailureCode = Extract<SessionRequestStartStoreResult, { readonly ok: false }>["code"];

class CompositePreparationRejected extends Error {
  constructor(readonly code: CompositeFailureCode) {
    super("Composite start/request preparation was rejected.");
  }
}

function requestIdForStart(operationId: string) {
  const requestId = validateRequestId(`req_${operationId.slice(3)}`);
  if (!requestId.ok) throw new Error("Stored start operation could not bind its linked request.");
  return requestId.value;
}

export class LinuxBunSqliteStore
  extends SqliteStoreCore
  implements
    OwnershipPort,
    DeliveryPersistencePort,
    RecoveryStartupBarrierPort,
    RequestAdmissionPersistencePort,
    RequestDeadlineSchedulePort,
    RequestRecoveryPersistencePort,
    RequestRetentionPersistencePort,
    RequestTerminalPersistencePort,
    RequestResultRetentionPersistencePort,
    RequestParticipantQueryPort,
    SessionStopPersistencePort,
    ParticipantDeletionPersistencePort,
    DeliveryRetentionPersistencePort,
    AdvisoryLockPersistencePort,
    SessionRequestStartPersistencePort
{
  async readSessionRequestStartByOperation(
    input: Parameters<
      NonNullable<SessionRequestStartPersistencePort["readSessionRequestStartByOperation"]>
    >[0],
  ): ReturnType<
    NonNullable<SessionRequestStartPersistencePort["readSessionRequestStartByOperation"]>
  > {
    this.assertOpen();
    return this.access.inspect(() => {
      this.ownershipRepository.assertOrdinaryWorkAllowed(input.fencingToken);
      if (input.workspaceKey !== this.context.workspaceKey) return undefined;
      const row = this.context.database
        .query<StartOperationRow, [string, string]>(
          `SELECT ${startOperationColumns} FROM start_operations
           WHERE workspace_key = ? AND id = ?`,
        )
        .get(input.workspaceKey, input.operationId);
      if (!row) return undefined;
      const operation = hydrateStartOperation(row);
      const request = this.requestRepository.getRequestMetadata({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        requestId: requestIdForStart(operation.id),
      });
      return request?.linkedStartOperationId === operation.id ? { operation, request } : undefined;
    });
  }

  async readSessionRequestStart(
    input: Parameters<SessionRequestStartPersistencePort["readSessionRequestStart"]>[0],
  ): ReturnType<SessionRequestStartPersistencePort["readSessionRequestStart"]> {
    this.assertOpen();
    return this.access.inspect(() => {
      this.ownershipRepository.assertOrdinaryWorkAllowed(input.fencingToken);
      if (input.workspaceKey !== this.context.workspaceKey) {
        return { ok: false as const, code: "state_conflict" as const };
      }
      const row = this.context.database
        .query<
          StartOperationRow & { readonly idempotencyDigest: string },
          [string, string, string]
        >(
          `SELECT ${startOperationColumns},
             COALESCE(idempotency_arguments_sha256, arguments_sha256) AS idempotencyDigest
           FROM start_operations
           WHERE workspace_key = ? AND source_session_id = ? AND idempotency_key = ?`,
        )
        .get(input.workspaceKey, input.sourceSessionId, input.idempotencyKey);
      if (!row) return { ok: true as const, found: false as const };
      if (row.idempotencyDigest !== input.idempotencyArgumentsSha256) {
        return { ok: false as const, code: "idempotency_conflict" as const };
      }
      const operation = hydrateStartOperation(row);
      const request = this.requestRepository.getRequestMetadata({
        fencingToken: input.fencingToken,
        workspaceKey: input.workspaceKey,
        requestId: requestIdForStart(operation.id),
      });
      return request?.linkedStartOperationId === operation.id
        ? { ok: true as const, found: true as const, operation, request }
        : { ok: false as const, code: "state_conflict" as const };
    });
  }

  async createOrResumeSessionRequestStart(
    input: PrepareSessionRequestStartInput,
  ): Promise<SessionRequestStartStoreResult> {
    this.assertOpen();
    return this.access.mutate(() => {
      if (
        input.request.creationOperationId !== input.start.operationId ||
        input.request.deliveryMode !== "initial" ||
        input.request.linkedStartOperationId !== input.start.operationId ||
        input.request.request.workspaceKey !== input.start.workspaceKey ||
        input.request.request.sourceSessionId !== input.start.sourceSessionId ||
        input.request.request.targetSessionId !== input.start.sessionId ||
        input.request.request.nativeMessageId !== input.start.nativeMessageId
      ) {
        return { ok: false as const, code: "state_conflict" as const };
      }
      try {
        return this.context.database
          .transaction(() => {
            const start = this.startRepository.createOrResumeInTransaction(input.start);
            if (!start.ok) throw new CompositePreparationRejected(start.code);

            // An exact idempotent replay must return the already-linked request rather than
            // attempting to insert candidate IDs generated by the new invocation.
            if (start.operation.id !== input.start.operationId) {
              const request = this.requestRepository.getRequestMetadata({
                fencingToken: input.start.fencingToken,
                workspaceKey: input.start.workspaceKey,
                requestId: requestIdForStart(start.operation.id),
              });
              if (!request || request.linkedStartOperationId !== start.operation.id) {
                throw new CompositePreparationRejected("state_conflict");
              }
              return {
                ok: true as const,
                operation: start.operation,
                request,
                idempotencyArgumentsSha256:
                  input.start.idempotencyArgumentsSha256 ?? input.start.argumentsSha256,
              };
            }

            const request = this.requestRepository.createPreparedInTransaction(input.request);
            if (!request.ok) throw new CompositePreparationRejected(request.code);
            return {
              ok: true as const,
              operation: start.operation,
              request: request.request,
              idempotencyArgumentsSha256:
                input.start.idempotencyArgumentsSha256 ?? input.start.argumentsSha256,
            };
          })
          .immediate();
      } catch (cause: unknown) {
        if (cause instanceof CompositePreparationRejected) {
          return { ok: false as const, code: cause.code };
        }
        throw cause;
      }
    });
  }
  async publish(
    input: Parameters<AdvisoryLockPersistencePort["publish"]>[0],
  ): ReturnType<AdvisoryLockPersistencePort["publish"]> {
    this.assertOpen();
    return this.access.mutate(() => this.advisoryLockRepository.publish(input));
  }

  async list(
    input: Parameters<AdvisoryLockPersistencePort["list"]>[0],
  ): ReturnType<AdvisoryLockPersistencePort["list"]> {
    this.assertOpen();
    return this.access.inspect(() => this.advisoryLockRepository.list(input));
  }

  async renew(
    input: Parameters<AdvisoryLockPersistencePort["renew"]>[0],
  ): ReturnType<AdvisoryLockPersistencePort["renew"]> {
    this.assertOpen();
    return this.access.mutate(() => this.advisoryLockRepository.renew(input));
  }

  async release(
    input: Parameters<AdvisoryLockPersistencePort["release"]>[0],
  ): ReturnType<AdvisoryLockPersistencePort["release"]> {
    this.assertOpen();
    return this.access.mutate(() => this.advisoryLockRepository.release(input));
  }

  async cleanupExpired(
    input: Parameters<AdvisoryLockPersistencePort["cleanupExpired"]>[0],
  ): ReturnType<AdvisoryLockPersistencePort["cleanupExpired"]> {
    this.assertOpen();
    return this.access.mutate(() => this.advisoryLockRepository.cleanupExpired(input));
  }

  async readNextExpiry(
    input: Parameters<AdvisoryLockPersistencePort["readNextExpiry"]>[0],
  ): ReturnType<AdvisoryLockPersistencePort["readNextExpiry"]> {
    this.assertOpen();
    return this.access.inspect(() => this.advisoryLockRepository.readNextExpiry(input));
  }

  async createPrepared(input: PrepareDeliveryInput): Promise<DeliveryStoreResult>;
  async createPrepared(input: PrepareRequestInput): Promise<RequestStoreResult>;
  async createPrepared(
    input: PrepareDeliveryInput | PrepareRequestInput,
  ): Promise<DeliveryStoreResult | RequestStoreResult> {
    this.assertOpen();
    return "request" in input
      ? this.access.mutate(() => this.requestRepository.createPrepared(input))
      : this.access.mutate(() => this.deliveryRepository.createPrepared(input));
  }

  async reconcilePreparedCreation(
    input: PrepareRequestInput,
  ): Promise<RequestCreationReconciliation> {
    this.assertOpen();
    return this.access.inspect(() => this.requestRepository.reconcilePreparedCreation(input));
  }

  async getRequestMetadata(input: RequestTransitionInput) {
    this.assertOpen();
    return this.access.inspect(() => this.requestRepository.getRequestMetadata(input));
  }

  async cancelPrepared(input: DeliveryTransitionInput): Promise<DeliveryStoreResult> {
    this.assertOpen();
    return this.access.mutate(() => this.deliveryRepository.cancelPrepared(input));
  }

  async claimPrepared(input: DeliveryTransitionInput): Promise<DeliveryClaimResult>;
  async claimPrepared(input: RequestTransitionInput): Promise<RequestClaimResult>;
  async claimPrepared(
    input: DeliveryTransitionInput | RequestTransitionInput,
  ): Promise<DeliveryClaimResult | RequestClaimResult> {
    this.assertOpen();
    return "requestId" in input
      ? this.access.mutate(() => this.requestRepository.claimPrepared(input))
      : this.access.mutate(() => this.deliveryRepository.claimPrepared(input));
  }

  async reconcilePreparedClaim(input: RequestTransitionInput): Promise<RequestClaimReconciliation> {
    this.assertOpen();
    return this.access.inspect(() => this.requestRepository.reconcilePreparedClaim(input));
  }

  async completeDelivery(input: CompleteRequestDeliveryInput): Promise<RequestStoreResult> {
    this.assertOpen();
    return this.access.mutate(() => this.requestDeliveryRepository.completeDelivery(input));
  }

  async expireDueRequests(
    input: Parameters<RequestAdmissionPersistencePort["expireDueRequests"]>[0],
  ): Promise<ExpireDueRequestsResult> {
    this.assertOpen();
    return this.access.mutate(() => this.requestRepository.expireDueRequests(input));
  }

  async readNextPendingDeadline(
    input: Parameters<RequestDeadlineSchedulePort["readNextPendingDeadline"]>[0],
  ): ReturnType<RequestDeadlineSchedulePort["readNextPendingDeadline"]> {
    this.assertOpen();
    return this.access.inspect(() => this.requestQueryRepository.readNextPendingDeadline(input));
  }

  async listRecoverableRequests(
    input: Parameters<RequestRecoveryPersistencePort["listRecoverableRequests"]>[0],
  ): Promise<readonly import("../../domain/request-types").RequestMetadata[]> {
    this.assertOpen();
    return this.access.inspect(() => this.requestQueryRepository.listRecoverable(input));
  }

  async listForParticipant(
    input: Parameters<RequestParticipantQueryPort["listForParticipant"]>[0],
  ): ReturnType<RequestParticipantQueryPort["listForParticipant"]> {
    this.assertOpen();
    return this.access.inspect(() => this.requestParticipantQueryRepository.list(input));
  }

  async getParticipantRequest(
    input: Parameters<RequestParticipantQueryPort["getParticipantRequest"]>[0],
  ): ReturnType<RequestParticipantQueryPort["getParticipantRequest"]> {
    this.assertOpen();
    return this.access.inspect(() => this.requestParticipantQueryRepository.get(input));
  }

  async collectRequestRetention(
    input: Parameters<RequestRetentionPersistencePort["collectRequestRetention"]>[0],
  ): Promise<RequestRetentionResult> {
    this.assertOpen();
    return this.access.mutate(() => this.requestRetentionRepository.collect(input));
  }

  async answerAsk(
    input: Parameters<RequestTerminalPersistencePort["answerAsk"]>[0],
  ): ReturnType<RequestTerminalPersistencePort["answerAsk"]> {
    this.assertOpen();
    return this.access.mutate(() => this.requestTerminalRepository.answerAsk(input));
  }

  async signalWait(
    input: Parameters<RequestTerminalPersistencePort["signalWait"]>[0],
  ): ReturnType<RequestTerminalPersistencePort["signalWait"]> {
    this.assertOpen();
    return this.access.mutate(() => this.requestTerminalRepository.signalWait(input));
  }

  async cancelPending(
    input: Parameters<RequestTerminalPersistencePort["cancelPending"]>[0],
  ): ReturnType<RequestTerminalPersistencePort["cancelPending"]> {
    this.assertOpen();
    return this.access.mutate(() => this.requestTerminalRepository.cancelPending(input));
  }

  async acknowledgeResult(
    input: Parameters<RequestTerminalPersistencePort["acknowledgeResult"]>[0],
  ): ReturnType<RequestTerminalPersistencePort["acknowledgeResult"]> {
    this.assertOpen();
    return this.access.mutate(() => this.requestTerminalRepository.acknowledgeResult(input));
  }

  async expireAvailableResults(
    input: Parameters<RequestResultRetentionPersistencePort["expireAvailableResults"]>[0],
  ): ReturnType<RequestResultRetentionPersistencePort["expireAvailableResults"]> {
    this.assertOpen();
    return this.access.mutate(() => this.requestResultRetentionRepository.expireAvailable(input));
  }

  async stopPendingRequests(
    input: Parameters<SessionStopPersistencePort["stopPendingRequests"]>[0],
  ): ReturnType<SessionStopPersistencePort["stopPendingRequests"]> {
    this.assertOpen();
    return this.access.mutate(() => this.requestStopRepository.stopPendingRequests(input));
  }

  async deleteParticipantRequests(
    input: Parameters<ParticipantDeletionPersistencePort["deleteParticipantRequests"]>[0],
  ): ReturnType<ParticipantDeletionPersistencePort["deleteParticipantRequests"]> {
    this.assertOpen();
    return this.access.mutate(() =>
      this.requestDeletionRepository.deleteParticipantRequests(input),
    );
  }

  async deleteAbsentParticipantRequests(input: DeleteAbsentParticipantRequestsInput) {
    this.assertOpen();
    return this.access.mutate(() => this.requestDeletionRepository.deleteAbsent(input));
  }

  async listParticipantDeletionCandidates(
    input: Parameters<ParticipantDeletionPersistencePort["listParticipantDeletionCandidates"]>[0],
  ): ReturnType<ParticipantDeletionPersistencePort["listParticipantDeletionCandidates"]> {
    this.assertOpen();
    return this.access.inspect(() =>
      this.requestDeletionRepository.listParticipantDeletionCandidates(input),
    );
  }

  async completeSubmission(input: CompleteSubmissionInput): Promise<DeliveryStoreResult> {
    this.assertOpen();
    return this.access.mutate(() => this.deliveryRepository.completeSubmission(input));
  }

  async listRecoverable(
    input: Parameters<DeliveryPersistencePort["listRecoverable"]>[0],
  ): Promise<readonly DeliveryMetadata[]> {
    this.assertOpen();
    return this.access.inspect(() => this.deliveryQueryRepository.listRecoverable(input));
  }

  async getForParticipant(input: {
    readonly workspaceKey: WorkspaceKey;
    readonly deliveryId: Parameters<DeliveryPersistencePort["getForParticipant"]>[0]["deliveryId"];
    readonly participantSessionId: SessionId;
  }): Promise<
    { readonly role: DeliveryParticipantRole; readonly delivery: DeliveryMetadata } | undefined
  > {
    this.assertOpen();
    return this.access.inspect(() => this.deliveryQueryRepository.getForParticipant(input));
  }

  async garbageCollectMetadata(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): Promise<unknown> {
    this.assertOpen();
    return this.access.mutate(() =>
      this.maintenanceRepository.garbageCollectDeliveryMetadata(input),
    );
  }

  async readStorageDiagnostics(): Promise<StoreStorageDiagnostics> {
    this.assertOpen();
    return this.access.mutate(() => this.maintenanceRepository.readStorageDiagnostics());
  }
}
