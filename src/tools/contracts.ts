import { z } from "zod";
import { validateDeliveryId } from "../domain/generated-ids";
import { validateMessageContent } from "../domain/message-payload";
import type { DomainFailureCode, DomainResult } from "../domain/results";
import { validateExportDestination } from "../domain/session-export";
import {
  validateStartAgent,
  validateStartIdempotencyKey,
  validateStartInitialMessage,
  validateStartModel,
  validateStartTitle,
} from "../domain/session-start";
import { validateSessionStopReason } from "../domain/session-stop";
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

export const sessionStopArgumentsSchema = z
  .object({
    session_id: z.string().superRefine((value, context) => {
      const validation = validateSessionId(value);
      if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
    }),
    reason: z
      .string()
      .superRefine((value, context) => {
        const validation = validateSessionStopReason(value);
        if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
      })
      .optional(),
  })
  .strict();

function startField(
  validator: (
    value: unknown,
  ) => { readonly ok: true } | { readonly ok: false; readonly message: string },
) {
  return z.string().superRefine((value, context) => {
    const result = validator(value);
    if (!result.ok) context.addIssue({ code: "custom", message: result.message });
  });
}

export const sessionStartArgumentsSchema = z
  .object({
    idempotency_key: startField(validateStartIdempotencyKey),
    initial_message: startField(validateStartInitialMessage),
    title: startField(validateStartTitle).optional(),
    agent: startField(validateStartAgent).optional(),
    model: startField(validateStartModel).optional(),
  })
  .strict();

export const sessionExportArgumentsSchema = z
  .object({
    session_id: z
      .string()
      .superRefine((value, context) => {
        const validation = validateSessionId(value);
        if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
      })
      .optional(),
    destination: z.string().superRefine((value, context) => {
      const validation = validateExportDestination(value);
      if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
    }),
    sanitize: z.boolean().optional().default(true),
    overwrite: z.boolean().optional().default(false),
  })
  .strict();

export type SessionListToolArguments = z.infer<typeof sessionListArgumentsSchema>;
export type SessionSendToolArguments = z.infer<typeof sessionSendArgumentsSchema>;
export type SessionDeliveryGetToolArguments = z.infer<typeof sessionDeliveryGetArgumentsSchema>;
export type SessionStopToolArguments = z.infer<typeof sessionStopArgumentsSchema>;
export type SessionStartToolArguments = z.infer<typeof sessionStartArgumentsSchema>;
export type SessionExportToolArguments = z.infer<typeof sessionExportArgumentsSchema>;

export const sessionListFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "deadline_expired",
  "native_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionSendFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "target_not_visible",
  "permission_denied",
  "approval_rejected",
  "deadline_expired",
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
  "deadline_expired",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionStopFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "target_not_visible",
  "approval_rejected",
  "deadline_expired",
  "native_unavailable",
  "native_outcome_unknown",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionStartFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "permission_denied",
  "approval_rejected",
  "deadline_expired",
  "quota_exceeded",
  "unresolved_provenance_quota_exceeded",
  "rate_limited",
  "idempotency_conflict",
  "state_conflict",
  "native_unavailable",
  "native_outcome_unknown",
  "start_payload_unavailable",
  "admission_failed",
  "admission_unknown",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionExportFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "target_not_visible",
  "approval_rejected",
  "permission_denied",
  "ownership_lost",
  "export_unavailable",
  "unsafe_path",
  "destination_exists",
  "export_limit_exceeded",
  "native_outcome_unknown",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];

export interface StructuralApprovalInput {
  readonly permission: string;
  readonly patterns: string[];
  readonly always: string[];
  readonly metadata: Record<string, unknown>;
}

export interface StructuralToolContext {
  readonly sessionID: string;
  readonly abort: AbortSignal;
  readonly messageID?: string;
  readonly ask?: (input: StructuralApprovalInput) => Promise<void>;
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
