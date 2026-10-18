import type { AdvisoryLockPersistencePort } from "../../application/advisory-lock-ports";
import type {
  ContextAdmissionParticipantQueryPort,
  ContextAdmissionPersistencePort,
  ParticipantContextPersistencePort,
} from "../../application/context-admission-ports";
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
import type { ParticipantRegistryPersistencePort } from "../../application/participant-registry-ports";
import type { ParticipantStopPersistencePort } from "../../application/participant-stop-ports";
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
import type { SessionStopPersistencePort } from "../../application/session-stop-ports";
import type { DeliveryMetadata, DeliveryParticipantRole } from "../../domain/deliveries";
import type { FencingToken } from "../../domain/ownership";
import type { SessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import { SqliteSessionRequestStartStore } from "./sqlite-session-request-start-store";
import type { StoreStorageDiagnostics } from "./store-maintenance-repository";

export class LinuxBunSqliteStore
  extends SqliteSessionRequestStartStore
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
    ParticipantStopPersistencePort,
    ParticipantDeletionPersistencePort,
    DeliveryRetentionPersistencePort,
    AdvisoryLockPersistencePort,
    ContextAdmissionPersistencePort,
    ParticipantContextPersistencePort,
    ContextAdmissionParticipantQueryPort,
    ParticipantRegistryPersistencePort
{
  async recordParticipantObservations(
    input: Parameters<ParticipantRegistryPersistencePort["recordParticipantObservations"]>[0],
  ): ReturnType<ParticipantRegistryPersistencePort["recordParticipantObservations"]> {
    this.assertOpen();
    return this.access.mutate(() => this.participantRegistryRepository.record(input));
  }

  async listParticipantRootCandidates(
    input: Parameters<ParticipantRegistryPersistencePort["listParticipantRootCandidates"]>[0],
  ): ReturnType<ParticipantRegistryPersistencePort["listParticipantRootCandidates"]> {
    this.assertOpen();
    return this.access.inspect(() => this.participantRegistryRepository.listRoots(input));
  }

  async getParticipantRootCandidate(
    input: Parameters<ParticipantRegistryPersistencePort["getParticipantRootCandidate"]>[0],
  ): ReturnType<ParticipantRegistryPersistencePort["getParticipantRootCandidate"]> {
    this.assertOpen();
    return this.access.inspect(() => this.participantRegistryRepository.getRoot(input));
  }

  async createContextMessage(
    input: Parameters<ContextAdmissionPersistencePort["createContextMessage"]>[0],
  ): ReturnType<ContextAdmissionPersistencePort["createContextMessage"]> {
    this.assertOpen();
    return this.access.mutate(() => this.contextAdmissionRepository.createMessage(input));
  }

  async getContextAdmission(
    input: Parameters<ContextAdmissionPersistencePort["getContextAdmission"]>[0],
  ): ReturnType<ContextAdmissionPersistencePort["getContextAdmission"]> {
    this.assertOpen();
    return this.access.inspect(() => this.contextAdmissionRepository.get(input));
  }

  async getContextAdmissionForParticipant(
    input: Parameters<ContextAdmissionParticipantQueryPort["getContextAdmissionForParticipant"]>[0],
  ): ReturnType<ContextAdmissionParticipantQueryPort["getContextAdmissionForParticipant"]> {
    this.assertOpen();
    return this.access.inspect(() => this.contextAdmissionRepository.getForParticipant(input));
  }

  async listPendingContext(
    input: Parameters<ContextAdmissionPersistencePort["listPendingContext"]>[0],
  ): ReturnType<ContextAdmissionPersistencePort["listPendingContext"]> {
    this.assertOpen();
    return this.access.inspect(() => this.contextAdmissionRepository.listPending(input));
  }

  async claimPendingContext(
    input: Parameters<ContextAdmissionPersistencePort["claimPendingContext"]>[0],
  ): ReturnType<ContextAdmissionPersistencePort["claimPendingContext"]> {
    this.assertOpen();
    return this.access.mutate(() => this.contextAdmissionRepository.claim(input));
  }

  async cancelContextAdmission(
    input: Parameters<ContextAdmissionPersistencePort["cancelContextAdmission"]>[0],
  ): ReturnType<ContextAdmissionPersistencePort["cancelContextAdmission"]> {
    this.assertOpen();
    return this.access.mutate(() => this.contextAdmissionRepository.cancel(input));
  }

  async readContextReminders(
    input: Parameters<ContextAdmissionPersistencePort["readContextReminders"]>[0],
  ): ReturnType<ContextAdmissionPersistencePort["readContextReminders"]> {
    this.assertOpen();
    return this.access.inspect(() => this.contextAdmissionRepository.readReminders(input));
  }

  async failPendingContextForParticipant(
    input: Parameters<ContextAdmissionPersistencePort["failPendingContextForParticipant"]>[0],
  ): ReturnType<ContextAdmissionPersistencePort["failPendingContextForParticipant"]> {
    this.assertOpen();
    return this.access.mutate(() => this.contextAdmissionRepository.failForTarget(input));
  }
  async settlePendingContextForParticipant(
    input: Parameters<ParticipantContextPersistencePort["settlePendingContextForParticipant"]>[0],
  ): ReturnType<ParticipantContextPersistencePort["settlePendingContextForParticipant"]> {
    this.assertOpen();
    return this.access.mutate(() => this.contextAdmissionRepository.settleForParticipant(input));
  }

  async failUncertainContextOnStartup(
    input: Parameters<ContextAdmissionPersistencePort["failUncertainContextOnStartup"]>[0],
  ): ReturnType<ContextAdmissionPersistencePort["failUncertainContextOnStartup"]> {
    this.assertOpen();
    return this.access.mutate(() => this.contextAdmissionRepository.failUncertainOnStartup(input));
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

  async stopPendingBlockingRequests(
    input: Parameters<ParticipantStopPersistencePort["stopPendingBlockingRequests"]>[0],
  ): ReturnType<ParticipantStopPersistencePort["stopPendingBlockingRequests"]> {
    this.assertOpen();
    return this.access.mutate(() => this.requestStopRepository.stopPendingBlockingRequests(input));
  }

  async listParticipantStopCandidates(
    input: Parameters<ParticipantStopPersistencePort["listParticipantStopCandidates"]>[0],
  ): ReturnType<ParticipantStopPersistencePort["listParticipantStopCandidates"]> {
    this.assertOpen();
    return this.access.inspect(() =>
      this.requestStopRepository.listParticipantStopCandidates(input),
    );
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
