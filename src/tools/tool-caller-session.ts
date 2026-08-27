import { type DomainResult, domainFailure } from "../domain/results";
import { type SessionId, validateSessionId } from "../domain/sessions";

export function toolCallerSession(value: unknown): DomainResult<SessionId> {
  const caller = validateSessionId(value);
  return caller.ok
    ? { ok: true, value: caller.value }
    : domainFailure("invalid_arguments", caller.message, false);
}
