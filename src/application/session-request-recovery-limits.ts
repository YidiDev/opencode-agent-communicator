import {
  pendingRequestsPerWorkspaceHardCeiling,
  submittingRequestsPerWorkspaceHardCeiling,
} from "../domain/safety-ceilings";

export const requestStartupPendingRecoveryMaximumRecords = pendingRequestsPerWorkspaceHardCeiling;
export const requestStartupSubmittingRecoveryMaximumRecords =
  submittingRequestsPerWorkspaceHardCeiling;
export const requestStartupExpiryBatchLimit = 100;
