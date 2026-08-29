import type { DomainFailureCode } from "../domain/results";

const requestMutationFailures = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "quota_exceeded",
  "rate_limited",
  "state_conflict",
  "request_not_pending",
  "request_cancelled",
  "deadline_expired",
  "delivery_failed",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];

const blockingRequestFailures = [
  "invalid_arguments",
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
  "request_cancelled",
  "deadline_expired",
  "deadlock_detected",
  "result_expired",
  "native_unavailable",
  "delivery_failed",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];

const requestListFailures = [
  "invalid_arguments",
  "caller_not_visible",
  "deadline_expired",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
const requestGetFailures = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "deadline_expired",
  "result_expired",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
const requestAckFailures = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "deadline_expired",
  "quota_exceeded",
  "rate_limited",
  "state_conflict",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
const requestCancelFailures = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "quota_exceeded",
  "rate_limited",
  "state_conflict",
  "request_not_pending",
  "deadline_expired",
  "delivery_failed",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];

type RequestToolName =
  | "session_ask"
  | "session_request_send"
  | "session_respond"
  | "session_wait"
  | "session_signal"
  | "session_request_list"
  | "session_request_get"
  | "session_request_ack"
  | "session_request_cancel";

export const requestToolFailureCodes = {
  session_ask: blockingRequestFailures,
  session_request_send: blockingRequestFailures,
  session_respond: requestMutationFailures,
  session_wait: blockingRequestFailures,
  session_signal: requestMutationFailures,
  session_request_list: requestListFailures,
  session_request_get: requestGetFailures,
  session_request_ack: requestAckFailures,
  session_request_cancel: requestCancelFailures,
} as const satisfies Record<RequestToolName, readonly DomainFailureCode[]>;

export const sessionBlockingRequestFailureCodes = requestToolFailureCodes.session_ask;
export const sessionRequestSendFailureCodes = requestToolFailureCodes.session_request_send;
export const sessionRespondFailureCodes = requestToolFailureCodes.session_respond;
export const sessionSignalFailureCodes = requestToolFailureCodes.session_signal;
export const sessionRequestListFailureCodes = requestToolFailureCodes.session_request_list;
export const sessionRequestGetFailureCodes = requestToolFailureCodes.session_request_get;
export const sessionRequestAckFailureCodes = requestToolFailureCodes.session_request_ack;
export const sessionRequestCancelFailureCodes = requestToolFailureCodes.session_request_cancel;
