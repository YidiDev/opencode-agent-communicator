/** Immutable cross-layer safety limits. Adapters may configure lower limits, never higher ones. */
export const deliveryRecordsPerWorkspaceHardCeiling = 50_000;
export const pendingRequestsPerWorkspaceHardCeiling = 1_024;
/** Includes pending and terminal request metadata whose delivery is still submitting. */
export const submittingRequestsPerWorkspaceHardCeiling = 4_096;
export const availableResultsPerWorkspaceHardCeiling = 4_096;
