import { z } from "zod";
import {
  validateAdvisoryLockDescription,
  validateAdvisoryLockInstructions,
  validateAdvisoryLockTitle,
  validateAdvisoryLockTtlSeconds,
} from "../domain/advisory-locks";
import { validateAdvisoryLockId, validateDeliveryId } from "../domain/generated-ids";
import { validateMessageContent } from "../domain/message-payload";
import type { DomainFailureCode } from "../domain/results";
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
import { immediateRequestSchema } from "./request-contracts";

export {
  type SessionReadToolArguments,
  sessionReadArgumentsSchema,
  sessionReadFailureCodes,
} from "./session-read-contracts";

export {
  type InternalToolContract,
  type StructuralToolContext,
  serializeDomainResult,
  ToolContractFault,
} from "./tool-contract";

export const sessionListArgumentsSchema = z
  .object({
    status: z.enum(["active", "idle", "all"]).optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

function advisoryLockField(
  validator: (
    value: unknown,
  ) => { readonly ok: true } | { readonly ok: false; readonly message: string },
) {
  return z.string().superRefine((value, context) => {
    const validation = validator(value);
    if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
  });
}

const nonemptyAdvisoryLockField = (
  validator: (
    value: unknown,
  ) => { readonly ok: true } | { readonly ok: false; readonly message: string },
) =>
  advisoryLockField(validator).superRefine((value, context) => {
    if (new TextEncoder().encode(value).length === 0) {
      context.addIssue({ code: "custom", message: "Field must contain at least one UTF-8 byte." });
    }
  });

const advisoryLockIdSchema = advisoryLockField(validateAdvisoryLockId);
const advisoryLockTtlSchema = z
  .number()
  .int()
  .superRefine((value, context) => {
    const validation = validateAdvisoryLockTtlSeconds(value);
    if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
  });

export const sessionLockListArgumentsSchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.number().int().min(1).max(100).optional().default(50),
  })
  .strict();

export const sessionLockPublishArgumentsSchema = z
  .object({
    ttl_seconds: advisoryLockTtlSchema,
    title: advisoryLockField(validateAdvisoryLockTitle),
    description: nonemptyAdvisoryLockField(validateAdvisoryLockDescription),
    instructions: nonemptyAdvisoryLockField(validateAdvisoryLockInstructions),
  })
  .strict();

export const sessionLockReleaseArgumentsSchema = z
  .object({ lock_id: advisoryLockIdSchema })
  .strict();

export const sessionLockRenewArgumentsSchema = z
  .object({ lock_id: advisoryLockIdSchema, ttl_seconds: advisoryLockTtlSchema })
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
    delivery: z.enum(["context", "user"]).optional(),
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
export const sessionRequestStartArgumentsSchema = sessionStartArgumentsSchema
  .extend({
    request: immediateRequestSchema,
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
    sanitize: z.literal(true).optional().default(true),
    overwrite: z.boolean().optional().default(false),
  })
  .strict();

export type SessionListToolArguments = z.infer<typeof sessionListArgumentsSchema>;
export type SessionLockListToolArguments = z.infer<typeof sessionLockListArgumentsSchema>;
export type SessionLockPublishToolArguments = z.infer<typeof sessionLockPublishArgumentsSchema>;
export type SessionLockReleaseToolArguments = z.infer<typeof sessionLockReleaseArgumentsSchema>;
export type SessionLockRenewToolArguments = z.infer<typeof sessionLockRenewArgumentsSchema>;
export type SessionSendToolArguments = z.infer<typeof sessionSendArgumentsSchema>;
export type SessionDeliveryGetToolArguments = z.infer<typeof sessionDeliveryGetArgumentsSchema>;
export type SessionStopToolArguments = z.infer<typeof sessionStopArgumentsSchema>;
export type SessionStartToolArguments = z.infer<typeof sessionStartArgumentsSchema>;
export type SessionRequestStartToolArguments = z.infer<typeof sessionRequestStartArgumentsSchema>;
export type SessionExportToolArguments = z.infer<typeof sessionExportArgumentsSchema>;

export const sessionListFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "deadline_expired",
  "native_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionLockListFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionLockPublishFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "quota_exceeded",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionLockOwnedMutationFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "not_found_or_unauthorized",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
export const sessionSendFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "target_not_visible",
  "target_idle",
  "target_status_unknown",
  "permission_denied",
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
  "permission_denied",
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
  "permission_denied",
  "ownership_lost",
  "export_unavailable",
  "unsafe_path",
  "destination_exists",
  "export_limit_exceeded",
  "native_outcome_unknown",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
