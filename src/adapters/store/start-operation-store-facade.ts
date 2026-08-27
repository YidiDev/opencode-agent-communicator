import type { StartOperationPersistencePort } from "../../application/session-start-ports";

type CapacityCheckedAccess = <Value>(operation: () => Value) => Value;

/** Keeps start persistence behind the same path/sidecar capacity checks as the store facade. */
export function createStartOperationStoreFacade(
  repository: StartOperationPersistencePort,
  access: CapacityCheckedAccess,
): StartOperationPersistencePort {
  const facade: StartOperationPersistencePort = {
    createOrResume: (input) => access(() => repository.createOrResume(input)),
    isManagedSession: (input) => access(() => repository.isManagedSession(input)),
    claimStep: (input) => access(() => repository.claimStep(input)),
    restorePreparedClaim: (input) => access(() => repository.restorePreparedClaim(input)),
    releasePreparedReservation: (input) =>
      access(() => repository.releasePreparedReservation(input)),
    rejectPreparedStart: (input) => access(() => repository.rejectPreparedStart(input)),
    classifyStaleSubmitting: (input) => access(() => repository.classifyStaleSubmitting(input)),
    reconcileUnknownCreation: (input) => access(() => repository.reconcileUnknownCreation(input)),
    completeCreation: (input) => access(() => repository.completeCreation(input)),
    completeTitle: (input) => access(() => repository.completeTitle(input)),
    completeAdmission: (input) => access(() => repository.completeAdmission(input)),
    listRecoverable: (input) => access(() => repository.listRecoverable(input)),
    collectRetention: (input) => access(() => repository.collectRetention(input)),
  };
  return Object.freeze(facade);
}
