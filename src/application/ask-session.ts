import type { DomainResult } from "../domain/results";
import {
  createBlockingSessionRequest,
  type SessionBlockingRequestContext,
  type SessionBlockingRequestPorts,
} from "./create-blocking-session-request";

export interface SessionAskArguments {
  readonly session_id: unknown;
  readonly questions: unknown;
  readonly timeout_seconds: unknown;
}

export interface SessionAskResult {
  readonly request_id: string;
  readonly state: "answered";
  readonly answers: readonly (readonly string[])[];
}

export async function askSession(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  args: SessionAskArguments,
): Promise<DomainResult<SessionAskResult>> {
  const result = await createBlockingSessionRequest(ports, context, "ask", args);
  return result;
}
