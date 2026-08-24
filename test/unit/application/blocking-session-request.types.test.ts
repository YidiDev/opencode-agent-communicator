import { expect, test } from "bun:test";

import type { SessionAskResult } from "../../../src/application/ask-session";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import { createBlockingSessionRequest } from "../../../src/application/create-blocking-session-request";
import type { SessionWaitResult } from "../../../src/application/wait-session";
import type { DomainResult } from "../../../src/domain/results";

declare const ports: SessionBlockingRequestPorts;
declare const context: SessionBlockingRequestContext;

function assertOperationTypes(): void {
  const ask: Promise<DomainResult<SessionAskResult>> = createBlockingSessionRequest(
    ports,
    context,
    "ask",
    {},
  );
  const wait: Promise<DomainResult<SessionWaitResult>> = createBlockingSessionRequest(
    ports,
    context,
    "wait",
    {},
  );
  // @ts-expect-error: operation overloads must keep wait results distinct from ask results.
  const wrong: Promise<DomainResult<SessionAskResult>> = wait;
  void ask;
  void wrong;
}
void assertOperationTypes;

test("blocking operation overloads are compile-time correlated", () => {
  expect(true).toBe(true);
});
