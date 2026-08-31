/** Immutable cross-layer safety limits. Adapters may configure lower limits, never higher ones. */
export const deliveryRecordsPerWorkspaceHardCeiling = 50_000;
export const pendingRequestsPerWorkspaceHardCeiling = 1_024;
/** Includes pending and terminal request metadata whose delivery is still submitting. */
export const submittingRequestsPerWorkspaceHardCeiling = 4_096;
export const availableResultsPerWorkspaceHardCeiling = 4_096;
export const managedSessionsPerWorkspaceHardCeiling = 1_024;
export const activeAdvisoryLocksPerWorkspaceHardCeiling = 1_024;
/** Distinct deletion candidates from pending requests/context, available results, and provenance. */
export const participantDeletionCandidatesHardCeiling =
  pendingRequestsPerWorkspaceHardCeiling * 2 +
  deliveryRecordsPerWorkspaceHardCeiling * 2 +
  availableResultsPerWorkspaceHardCeiling +
  managedSessionsPerWorkspaceHardCeiling;
/** Distinct source and target participants from pending blocking requests and context admissions. */
export const participantStopCandidatesHardCeiling =
  pendingRequestsPerWorkspaceHardCeiling * 2 + deliveryRecordsPerWorkspaceHardCeiling * 2;
/** Ambiguous deterministic creates are isolated from the ordinary managed-session budget. */
export const unresolvedStartProvenancePerWorkspaceHardCeiling = 128;
export const startOperationsRecoveryHardCeiling = 1_024;
export const startRecoveryScanHardCeiling =
  startOperationsRecoveryHardCeiling + unresolvedStartProvenancePerWorkspaceHardCeiling;
export const startOperationsPerWorkspaceHardCeiling = 4_096;
export const startPayloadBytesPerWorkspaceHardCeiling = 32 * 1_024 * 1_024;
export const startRateEventsPerWorkspaceHardCeiling = 1_000;
export const startsPerSourceWindowHardCeiling = 100;
export const startsPerWorkspaceWindowHardCeiling = 1_000;
export const startTerminalRetentionMsHardCeiling = 30 * 24 * 60 * 60 * 1_000;
