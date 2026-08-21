import { z } from "zod";
import { validateDeliveryId } from "../domain/generated-ids";
import { validateMessageContent } from "../domain/message-payload";
import type { DomainFailureCode, DomainResult } from "../domain/results";
import { validateSessionId } from "../domain/sessions";

export const sessionListArgumentsSchema = z
  .object({
    status: z.enum(["active", "idle", "all"]).optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const sessionSendArgumentsSchema = z
  .object({
    session_id: z.string().superRefine((value, context) => {
      const validation = validateSessionId(value);
      if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
    }),
    content: z.string().superRefine((value, context) => {
      const validation = validateMessageContent(value);
      if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
    }),
  })
  .strict();

export const sessionDeliveryGetArgumentsSchema = z
  .object({
    delivery_id: z.string().superRefine((value, context) => {
      const validation = validateDeliveryId(value);
      if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
    }),
  })
  .strict();

export type SessionListToolArguments = z.infer<typeof sessionListArgumentsSchema>;
export type SessionSendToolArguments = z.infer<typeof sessionSendArgumentsSchema>;
export type SessionDeliveryGetToolArguments = z.infer<typeof sessionDeliveryGetArgumentsSchema>;

export const sessionListFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "native_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionSendFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "target_not_visible",
  "permission_denied",
  "approval_rejected",
  "quota_exceeded",
  "rate_limited",
  "state_conflict",
  "native_unavailable",
  "admission_failed",
  "admission_unknown",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionDeliveryGetFailureCodes = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];

export interface StructuralToolContext {
  readonly sessionID: string;
  readonly abort: AbortSignal;
}

export interface InternalToolContract<Arguments> {
  readonly description: string;
  readonly args: z.ZodType<Arguments>;
  execute(arguments_: Arguments, context: StructuralToolContext): Promise<string>;
}

export class ToolContractFault extends Error {
  override readonly name = "ToolContractFault";

  constructor() {
    super("Application returned an undeclared tool outcome.");
  }
}

export function serializeDomainResult<Input, Output>(
  result: DomainResult<Input>,
  mapValue: (value: Input) => Output,
  allowedFailureCodes: readonly DomainFailureCode[],
): string {
  if (result.ok) return JSON.stringify({ ok: true, value: mapValue(result.value) });
  if (allowedFailureCodes.includes(result.error.code)) return JSON.stringify(result);
  throw new ToolContractFault();
}
