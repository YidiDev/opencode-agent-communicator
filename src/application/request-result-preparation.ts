import type { Sha256DigestPort } from "../domain/message-payload";
import { canonicalizeSerializeAndDigestRetainedRequestResult } from "../domain/request-serialization";
import type { DomainResult } from "../domain/results";
import { type AbortableSettlement, runUntilAborted } from "./abortable-operation";
import type { ClockPort } from "./delivery-ports";
import {
  checkRequestMutationControl,
  malformedRequestStoreFailure,
  type SessionRequestMutationContext,
} from "./request-terminal-use-case";
import { createLinkedEffectControl } from "./startup-effect-control";

export interface RequestMutationDigestPorts {
  readonly clock: ClockPort;
  readonly digest: Sha256DigestPort;
}

type RetainedResultPreparation = Awaited<
  ReturnType<typeof canonicalizeSerializeAndDigestRetainedRequestResult>
>;
type PreparedRetainedResult = Extract<RetainedResultPreparation, { readonly ok: true }>;

export async function prepareSubmittedRetainedResult(
  ports: RequestMutationDigestPorts,
  context: Pick<SessionRequestMutationContext, "abort" | "deadlineMs">,
  result: unknown,
): Promise<DomainResult<PreparedRetainedResult>> {
  const initialControl = checkRequestMutationControl(ports, context);
  if (!initialControl.ok) return initialControl;
  const control = createLinkedEffectControl({
    signals: [context.abort],
    deadlineMs: context.deadlineMs,
    clock: ports.clock,
  });
  if (!control) return malformedRequestStoreFailure();
  let prepared: AbortableSettlement<RetainedResultPreparation>;
  try {
    prepared = await runUntilAborted(control.signal, () =>
      canonicalizeSerializeAndDigestRetainedRequestResult(ports.digest, result),
    );
  } finally {
    control.dispose();
  }
  if (prepared.kind !== "settled") {
    const failedControl = checkRequestMutationControl(ports, context);
    if (!failedControl.ok) return failedControl;
    return malformedRequestStoreFailure();
  }
  const settledControl = checkRequestMutationControl(ports, context);
  if (!settledControl.ok) return settledControl;
  return prepared.value.ok ? { ok: true, value: prepared.value } : malformedRequestStoreFailure();
}
