import { describe, expect, test } from "bun:test";

import {
  type DomainFailureCode,
  domainFailure,
  domainFailureCodes,
} from "../../../src/domain/results";

const expectedCodes = [
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
] as const satisfies readonly DomainFailureCode[];

const expectedCodesAreExhaustive: Exclude<
  DomainFailureCode,
  (typeof expectedCodes)[number]
> extends never
  ? true
  : false = true;

describe("domain failure contract", () => {
  test("contains the complete shared minimum code union", () => {
    expect(domainFailureCodes).toEqual(expectedCodes);
    expect(new Set(domainFailureCodes).size).toBe(domainFailureCodes.length);
    expect(expectedCodesAreExhaustive).toBe(true);
  });

  test("maps every shared code to the common failure shape", () => {
    const failures = domainFailureCodes.map((code) => domainFailure(code, `safe ${code}`, false));
    expect(failures).toHaveLength(expectedCodes.length);
    for (const [index, code] of expectedCodes.entries()) {
      expect(failures[index]).toEqual({
        ok: false,
        error: { code, message: `safe ${code}`, retryable: false },
      });
    }
  });

  test("includes optional safe details only when supplied", () => {
    expect(domainFailure("state_conflict", "Safe conflict.", true, { state: "terminal" })).toEqual({
      ok: false,
      error: {
        code: "state_conflict",
        message: "Safe conflict.",
        retryable: true,
        details: { state: "terminal" },
      },
    });
  });
});
