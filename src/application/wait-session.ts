import type { DomainResult } from "../domain/results";
import {
  createBlockingSessionRequest,
  type SessionBlockingRequestContext,
  type SessionBlockingRequestPorts,
} from "./create-blocking-session-request";

export interface SessionWaitArguments {
  readonly session_id: unknown;
  readonly milestone: unknown;
  readonly timeout_seconds: unknown;
}

export interface SessionWaitResult {
  readonly request_id: string;
  readonly state: "reached";
  readonly evidence?: string;
}

export async function waitSession(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  args: SessionWaitArguments,
): Promise<DomainResult<SessionWaitResult>> {
  const result = await createBlockingSessionRequest(ports, context, "wait", args);
  return result;
}
