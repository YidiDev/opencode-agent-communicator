import { type DomainResult, domainFailure } from "../domain/results";
import type { ExportAdapterFailureCode, ExportAdapterResult } from "./session-export-ports";

const failureCodes: readonly ExportAdapterFailureCode[] = [
  "caller_not_visible",
  "target_not_visible",
  "export_unavailable",
  "unsafe_path",
  "destination_exists",
  "export_limit_exceeded",
  "native_outcome_unknown",
  "ownership_lost",
  "storage_unavailable",
];

export function isExportAdapterResult(value: unknown): value is ExportAdapterResult {
  if (!value || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok) {
    return (
      Object.keys(value).sort().join(",") === "byteCount,contentSha256,ok" &&
      "byteCount" in value &&
      typeof value.byteCount === "number" &&
      Number.isSafeInteger(value.byteCount) &&
      value.byteCount >= 0 &&
      "contentSha256" in value &&
      typeof value.contentSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.contentSha256)
    );
  }
  return (
    Object.keys(value).sort().join(",") === "code,ok" &&
    "code" in value &&
    failureCodes.includes(value.code as ExportAdapterFailureCode)
  );
}

export function exportAdapterFailure(code: ExportAdapterFailureCode): DomainResult<never> {
  const retryable = code === "export_unavailable" || code === "storage_unavailable";
  const messages: Record<ExportAdapterFailureCode, string> = {
    caller_not_visible: "Caller is not a current visible root session.",
    target_not_visible: "Target is not a current visible root session.",
    export_unavailable: "Native session export is unavailable.",
    unsafe_path: "The export destination could not be used safely.",
    destination_exists: "The export destination already exists.",
    export_limit_exceeded: "A session export safety limit was exceeded.",
    native_outcome_unknown: "The native export or install outcome is unknown.",
    ownership_lost: "Coordinator ownership was lost.",
    storage_unavailable: "Export storage is unavailable.",
  };
  return domainFailure(code, messages[code], retryable);
}
