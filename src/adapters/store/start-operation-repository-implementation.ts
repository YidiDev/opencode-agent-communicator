import type {
  StartOperationPersistencePort,
  StartStoreResult,
} from "../../application/session-start-ports";
import type { StartOperation } from "../../domain/session-start";
import type { OwnershipRepository } from "./ownership-repository";
import { startOperationFailure } from "./start-operation-failure";
import { StartOperationMaintenanceRepository } from "./start-operation-maintenance-repository";
import { StartOperationPreparationRepository } from "./start-operation-preparation-repository";
import { StartOperationRecords } from "./start-operation-records";
import { StartOperationResolutionRepository } from "./start-operation-resolution-repository";
import { StartOperationTransitionRepository } from "./start-operation-transition-repository";
import type { StoreContext } from "./store-types";

export class StartOperationRepository implements StartOperationPersistencePort {
  private readonly records: StartOperationRecords;
  private readonly maintenance: StartOperationMaintenanceRepository;
  private readonly preparation: StartOperationPreparationRepository;
  private readonly resolution: StartOperationResolutionRepository;
  private readonly transitions: StartOperationTransitionRepository;

  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {
    this.records = new StartOperationRecords(context);
    this.maintenance = new StartOperationMaintenanceRepository(context, ownership);
    this.preparation = new StartOperationPreparationRepository(
      context,
      ownership,
      this.records,
      this.maintenance,
    );
    this.resolution = new StartOperationResolutionRepository(context, ownership, this.records);
    this.transitions = new StartOperationTransitionRepository(context, ownership, this.records);
  }

  async createOrResume(
    input: Parameters<StartOperationPersistencePort["createOrResume"]>[0],
  ): Promise<StartStoreResult> {
    return this.preparation.createOrResume(input);
  }

  async isManagedSession(input: Parameters<StartOperationPersistencePort["isManagedSession"]>[0]) {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    if (input.workspaceKey !== this.context.workspaceKey) return false;
    return Boolean(
      this.context.database
        .query<{ found: number }, [string, string]>(
          "SELECT 1 AS found FROM managed_sessions WHERE workspace_key = ? AND session_id = ?",
        )
        .get(input.workspaceKey, input.sessionId),
    );
  }

  claimStep(input: Parameters<StartOperationPersistencePort["claimStep"]>[0]) {
    return this.transitions.claimStep(input);
  }

  restorePreparedClaim(
    input: Parameters<StartOperationPersistencePort["restorePreparedClaim"]>[0],
  ) {
    return this.transitions.restorePreparedClaim(input);
  }

  classifyStaleSubmitting(
    input: Parameters<StartOperationPersistencePort["classifyStaleSubmitting"]>[0],
  ) {
    return this.transitions.classifyStaleSubmitting(input);
  }

  reconcileUnknownCreation(
    input: Parameters<StartOperationPersistencePort["reconcileUnknownCreation"]>[0],
  ) {
    return this.resolution.reconcileUnknownCreation(input);
  }

  releasePreparedReservation(
    input: Parameters<StartOperationPersistencePort["releasePreparedReservation"]>[0],
  ) {
    return this.resolution.releasePreparedReservation(input);
  }

  rejectPreparedStart(input: Parameters<StartOperationPersistencePort["rejectPreparedStart"]>[0]) {
    return this.resolution.rejectPreparedStart(input);
  }

  completeCreation(input: Parameters<StartOperationPersistencePort["completeCreation"]>[0]) {
    return this.transitions.completeCreation(input);
  }

  completeTitle(input: Parameters<StartOperationPersistencePort["completeTitle"]>[0]) {
    return this.transitions.completeTitle(input);
  }

  completeAdmission(input: Parameters<StartOperationPersistencePort["completeAdmission"]>[0]) {
    return this.transitions.completeAdmission(input);
  }

  async listRecoverable(
    input: Parameters<StartOperationPersistencePort["listRecoverable"]>[0],
  ): Promise<readonly StartOperation[]> {
    return this.maintenance.listRecoverable(input);
  }

  async collectRetention(
    input: Parameters<StartOperationPersistencePort["collectRetention"]>[0],
  ): ReturnType<StartOperationPersistencePort["collectRetention"]> {
    try {
      return this.maintenance.collectRetention(input);
    } catch (cause: unknown) {
      return startOperationFailure(cause) as Extract<
        Awaited<ReturnType<StartOperationPersistencePort["collectRetention"]>>,
        { readonly ok: false }
      >;
    }
  }
}
