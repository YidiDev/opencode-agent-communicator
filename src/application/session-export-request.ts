import { type DomainResult, domainFailure } from "../domain/results";
import { type SessionExportRequest, validateExportDestination } from "../domain/session-export";
import { type SessionId, validateSessionId } from "../domain/sessions";

export interface SessionExportArguments {
  readonly session_id?: unknown;
  readonly destination: unknown;
  readonly sanitize?: unknown;
  readonly overwrite?: unknown;
}

export function sessionExportRequest(
  sourceSessionId: SessionId,
  args: SessionExportArguments,
): DomainResult<SessionExportRequest> {
  const target = validateSessionId(args.session_id ?? sourceSessionId);
  if (!target.ok) return domainFailure("invalid_arguments", target.message, false);
  const destination = validateExportDestination(args.destination);
  if (!destination.ok) return domainFailure("invalid_arguments", destination.message, false);
  if (args.sanitize !== undefined && args.sanitize !== true) {
    return domainFailure("invalid_arguments", "Unsanitized session export is unsupported.", false);
  }
  if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") {
    return domainFailure("invalid_arguments", "overwrite must be a boolean.", false);
  }
  return {
    ok: true,
    value: {
      sessionId: target.value,
      destination: destination.value,
      isSanitized: args.sanitize ?? true,
      shouldOverwrite: args.overwrite ?? false,
    },
  };
}
