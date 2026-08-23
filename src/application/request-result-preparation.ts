import type { Sha256DigestPort } from "../domain/message-payload";
import { canonicalizeSerializeAndDigestRetainedRequestResult } from "../domain/request-serialization";
import type { DomainResult } from "../domain/results";
import type { ClockPort } from "./delivery-ports";
import {
  assertRequestMutationControl,
  malformedRequestStoreFailure,
  type SessionRequestMutationContext,
} from "./request-terminal-use-case";

export interface RequestMutationDigestPorts {
  readonly clock: ClockPort;
  readonly digest: Sha256DigestPort;
}

type PreparedRetainedResult = Extract<
  Awaited<ReturnType<typeof canonicalizeSerializeAndDigestRetainedRequestResult>>,
  { readonly ok: true }
>;

export async function prepareSubmittedRetainedResult(
  ports: RequestMutationDigestPorts,
  context: Pick<SessionRequestMutationContext, "abort" | "deadlineMs">,
  result: unknown,
): Promise<DomainResult<PreparedRetainedResult>> {
  assertRequestMutationControl(ports, context);
  let prepared: Awaited<ReturnType<typeof canonicalizeSerializeAndDigestRetainedRequestResult>>;
  try {
    prepared = await canonicalizeSerializeAndDigestRetainedRequestResult(ports.digest, result);
  } catch {
    assertRequestMutationControl(ports, context);
    return malformedRequestStoreFailure();
  }
  assertRequestMutationControl(ports, context);
  return prepared.ok ? { ok: true, value: prepared } : malformedRequestStoreFailure();
}
