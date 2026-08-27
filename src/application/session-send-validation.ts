import { validateMessageContent } from "../domain/message-payload";
import { type DomainResult, domainFailure } from "../domain/results";
import { type SessionId, validateSessionId } from "../domain/sessions";
import type { CurrentRootMembership } from "./delivery-ports";

export interface SessionSendArguments {
  readonly session_id: unknown;
  readonly content: unknown;
}

export interface ValidatedSendInput {
  readonly target: SessionId;
  readonly content: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

export function sendVisibilityFailure(
  membership: CurrentRootMembership,
): DomainResult<never> | undefined {
  if (!membership.sourceVisible) {
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  }
  if (!membership.targetVisible) {
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  }
  return undefined;
}

export function validateSendArguments(
  args: SessionSendArguments,
): DomainResult<ValidatedSendInput> {
  const target = validateSessionId(args.session_id);
  if (!target.ok) return domainFailure("invalid_arguments", target.message, false);
  const content = validateMessageContent(args.content);
  if (!content.ok) return domainFailure("invalid_arguments", content.message, false);
  return {
    ok: true,
    value: {
      target: target.value,
      content: args.content as string,
      bytes: content.bytes,
      byteLength: content.byteLength,
    },
  };
}
