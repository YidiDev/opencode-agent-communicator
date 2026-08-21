export const domainFailureCodes = [
  "invalid_arguments",
  "incompatible_host",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "target_not_visible",
  "permission_denied",
  "approval_rejected",
  "target_idle",
  "target_status_unknown",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
  "quota_exceeded",
  "rate_limited",
  "idempotency_conflict",
  "state_conflict",
  "request_not_pending",
  "request_cancelled",
  "deadline_expired",
  "deadlock_detected",
  "result_expired",
  "native_unavailable",
  "admission_failed",
  "admission_unknown",
  "delivery_failed",
  "native_outcome_unknown",
  "ownership_lost",
  "storage_unavailable",
  "export_unavailable",
  "unsafe_path",
  "destination_exists",
  "export_limit_exceeded",
] as const;

export type DomainFailureCode = (typeof domainFailureCodes)[number];

export type SafeErrorDetails = Readonly<Record<string, unknown>>;

export type DomainResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: DomainFailureCode;
        readonly message: string;
        readonly retryable: boolean;
        readonly details?: SafeErrorDetails;
      };
    };

export function domainFailure(
  code: DomainFailureCode,
  message: string,
  retryable: boolean,
  details?: SafeErrorDetails,
): DomainResult<never> {
  return details === undefined
    ? { ok: false, error: { code, message, retryable } }
    : { ok: false, error: { code, message, retryable, details } };
}
