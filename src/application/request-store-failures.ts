export const requestStoreFailureCodes = [
  "deadlock_detected",
  "quota_exceeded",
  "rate_limited",
  "ownership_lost",
  "state_conflict",
  "storage_unavailable",
] as const;

export type RequestStoreFailureCode = (typeof requestStoreFailureCodes)[number];
