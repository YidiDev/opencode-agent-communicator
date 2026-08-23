import { type DomainResult, domainFailure } from "../domain/results";
import type {
  PreparedSessionRequestRecoverySummary,
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "./request-ports";
import { expireDueSessionRequests as expireDueInternal } from "./session-request-expiry";
import {
  classifyStaleSessionRequests as classifyStaleInternal,
  recoverPreparedSessionRequests as recoverPreparedInternal,
} from "./session-request-recovery-implementation";

export type {
  PreparedSessionRequestRecoverySummary,
  SessionRequestRecoveryPhaseInput,
  SessionRequestRecoveryPorts,
} from "./request-ports";
export {
  requestStartupExpiryBatchLimit,
  requestStartupPendingRecoveryMaximumRecords,
  requestStartupSubmittingRecoveryMaximumRecords,
} from "./session-request-recovery-limits";

function totalFailure(): DomainResult<never> {
  return domainFailure("storage_unavailable", "Request recovery boundary failed safely.", true);
}

export async function classifyStaleSessionRequests(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
): Promise<DomainResult<number>> {
  try {
    return await classifyStaleInternal(ports, input);
  } catch {
    return totalFailure();
  }
}

export async function expireDueSessionRequests(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
): Promise<DomainResult<number>> {
  try {
    return await expireDueInternal(ports, input);
  } catch {
    return totalFailure();
  }
}

export async function recoverPreparedSessionRequests(
  ports: SessionRequestRecoveryPorts,
  input: SessionRequestRecoveryPhaseInput,
): Promise<DomainResult<PreparedSessionRequestRecoverySummary>> {
  try {
    return await recoverPreparedInternal(ports, input);
  } catch {
    return totalFailure();
  }
}
