import { z } from "zod";
import { parseRequestListCursor } from "../application/request-list-cursor";
import { validateRequestId } from "../domain/generated-ids";
import { validateMessageContent } from "../domain/message-payload";
import { requestLimits } from "../domain/request-constants";
import {
  validateAskRequestPayload,
  validateRetainedAskRequestResult,
  validateWaitRequestPayload,
  validateWaitRequestResult,
} from "../domain/request-content";
import type { DomainFailureCode } from "../domain/results";
import { validateSessionId } from "../domain/sessions";

function issue(context: z.core.$RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}

function requestIdSchema(): z.ZodString {
  return z.string().superRefine((value, context) => {
    const validation = validateRequestId(value);
    if (!validation.ok) issue(context, validation.message);
  });
}

function sessionIdSchema(): z.ZodString {
  return z.string().superRefine((value, context) => {
    const validation = validateSessionId(value);
    if (!validation.ok) issue(context, validation.message);
  });
}

const askQuestionSchema = z
  .object({
    prompt: z.string(),
    options: z.array(z.string()).max(requestLimits.maximumOptionsPerQuestion),
    multiple: z.boolean().optional(),
    allow_custom: z.boolean().optional(),
  })
  .strict();

export const immediateAskRequestSchema = z
  .object({
    kind: z.literal("ask"),
    questions: z
      .array(askQuestionSchema)
      .min(requestLimits.minimumQuestions)
      .max(requestLimits.maximumQuestions),
    timeout_seconds: z
      .number()
      .int()
      .min(requestLimits.minimumTimeoutSeconds)
      .max(requestLimits.maximumTimeoutSeconds),
  })
  .strict();
export const immediateWaitRequestSchema = z
  .object({
    kind: z.literal("wait"),
    milestone: z.string(),
    timeout_seconds: z
      .number()
      .int()
      .min(requestLimits.minimumTimeoutSeconds)
      .max(requestLimits.maximumTimeoutSeconds),
  })
  .strict();
export const immediateRequestSchema = z
  .discriminatedUnion("kind", [immediateAskRequestSchema, immediateWaitRequestSchema])
  .superRefine((value, context) => {
    const validation =
      value.kind === "ask"
        ? validateAskRequestPayload({
            kind: "ask",
            questions: value.questions.map((question) => ({
              prompt: question.prompt,
              options: question.options,
              multiple: question.multiple ?? false,
              allowCustom: question.allow_custom ?? false,
            })),
            timeoutSeconds: value.timeout_seconds,
          })
        : validateWaitRequestPayload({
            kind: "wait",
            milestone: value.milestone,
            timeoutSeconds: value.timeout_seconds,
          });
    if (!validation.ok) issue(context, validation.message);
  });

export const sessionRequestSendArgumentsSchema = z
  .object({
    session_id: sessionIdSchema(),
    content: z.string().superRefine((value, context) => {
      const validation = validateMessageContent(value);
      if (!validation.ok) issue(context, validation.message);
    }),
    request: immediateRequestSchema,
  })
  .strict();

export const sessionAskArgumentsSchema = z
  .object({
    session_id: sessionIdSchema(),
    questions: z
      .array(askQuestionSchema)
      .min(requestLimits.minimumQuestions)
      .max(requestLimits.maximumQuestions),
    timeout_seconds: z
      .number()
      .int()
      .min(requestLimits.minimumTimeoutSeconds)
      .max(requestLimits.maximumTimeoutSeconds),
  })
  .strict()
  .superRefine((value, context) => {
    const validation = validateAskRequestPayload({
      kind: "ask",
      questions: value.questions.map((question) => ({
        prompt: question.prompt,
        options: question.options,
        multiple: question.multiple ?? false,
        allowCustom: question.allow_custom ?? false,
      })),
      timeoutSeconds: value.timeout_seconds,
    });
    if (!validation.ok) issue(context, validation.message);
  });

export const sessionRespondArgumentsSchema = z
  .object({
    request_id: requestIdSchema(),
    answers: z
      .array(z.array(z.string()).max(requestLimits.maximumAnswersPerQuestion))
      .min(requestLimits.minimumQuestions)
      .max(requestLimits.maximumQuestions),
  })
  .strict()
  .superRefine((value, context) => {
    const validation = validateRetainedAskRequestResult({ kind: "ask", answers: value.answers });
    if (!validation.ok) issue(context, validation.message);
  });

export const sessionWaitArgumentsSchema = z
  .object({
    session_id: sessionIdSchema(),
    milestone: z.string(),
    timeout_seconds: z
      .number()
      .int()
      .min(requestLimits.minimumTimeoutSeconds)
      .max(requestLimits.maximumTimeoutSeconds),
  })
  .strict()
  .superRefine((value, context) => {
    const validation = validateWaitRequestPayload({
      kind: "wait",
      milestone: value.milestone,
      timeoutSeconds: value.timeout_seconds,
    });
    if (!validation.ok) issue(context, validation.message);
  });

export const sessionSignalArgumentsSchema = z
  .object({ request_id: requestIdSchema(), evidence: z.string().optional() })
  .strict()
  .superRefine((value, context) => {
    const validation = validateWaitRequestResult(
      value.evidence === undefined ? { kind: "wait" } : { kind: "wait", evidence: value.evidence },
    );
    if (!validation.ok) issue(context, validation.message);
  });

export const sessionRequestListArgumentsSchema = z
  .object({
    role: z.enum(["inbox", "outbox", "all"]).optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cursor === undefined) return;
    const validation = parseRequestListCursor(value.cursor, value.role ?? "all");
    if (!validation.ok) issue(context, validation.message);
  });

export const sessionRequestGetArgumentsSchema = z
  .object({ request_id: requestIdSchema() })
  .strict();
export const sessionRequestAckArgumentsSchema = sessionRequestGetArgumentsSchema;
export const sessionRequestCancelArgumentsSchema = sessionRequestGetArgumentsSchema;

export type SessionAskToolArguments = z.infer<typeof sessionAskArgumentsSchema>;
export type SessionRequestSendToolArguments = z.infer<typeof sessionRequestSendArgumentsSchema>;
export type SessionRespondToolArguments = z.infer<typeof sessionRespondArgumentsSchema>;
export type SessionWaitToolArguments = z.infer<typeof sessionWaitArgumentsSchema>;
export type SessionSignalToolArguments = z.infer<typeof sessionSignalArgumentsSchema>;
export type SessionRequestListToolArguments = z.infer<typeof sessionRequestListArgumentsSchema>;
export type SessionRequestGetToolArguments = z.infer<typeof sessionRequestGetArgumentsSchema>;
export type SessionRequestAckToolArguments = z.infer<typeof sessionRequestAckArgumentsSchema>;
export type SessionRequestCancelToolArguments = z.infer<typeof sessionRequestCancelArgumentsSchema>;

const requestMutationFailures = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "quota_exceeded",
  "rate_limited",
  "state_conflict",
  "request_not_pending",
  "request_cancelled",
  "deadline_expired",
  "delivery_failed",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];

const blockingRequestFailures = [
  "invalid_arguments",
  "caller_not_visible",
  "target_not_visible",
  "permission_denied",
  "approval_rejected",
  "target_idle",
  "target_status_unknown",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
  "quota_exceeded",
  "rate_limited",
  "request_cancelled",
  "deadline_expired",
  "deadlock_detected",
  "result_expired",
  "native_unavailable",
  "delivery_failed",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];

const requestListFailures = [
  "invalid_arguments",
  "caller_not_visible",
  "deadline_expired",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
const requestGetFailures = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "deadline_expired",
  "result_expired",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
const requestAckFailures = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "deadline_expired",
  "quota_exceeded",
  "rate_limited",
  "state_conflict",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];
const requestCancelFailures = [
  "invalid_arguments",
  "not_found_or_unauthorized",
  "caller_not_visible",
  "quota_exceeded",
  "rate_limited",
  "state_conflict",
  "request_not_pending",
  "deadline_expired",
  "delivery_failed",
  "target_stopped",
  "source_stopped",
  "target_deleted",
  "source_deleted",
  "native_unavailable",
  "ownership_lost",
  "storage_unavailable",
] as const satisfies readonly DomainFailureCode[];

type RequestToolName =
  | "session_ask"
  | "session_request_send"
  | "session_respond"
  | "session_wait"
  | "session_signal"
  | "session_request_list"
  | "session_request_get"
  | "session_request_ack"
  | "session_request_cancel";

export const requestToolFailureCodes = {
  session_ask: blockingRequestFailures,
  session_request_send: blockingRequestFailures,
  session_respond: requestMutationFailures,
  session_wait: blockingRequestFailures,
  session_signal: requestMutationFailures,
  session_request_list: requestListFailures,
  session_request_get: requestGetFailures,
  session_request_ack: requestAckFailures,
  session_request_cancel: requestCancelFailures,
} as const satisfies Record<RequestToolName, readonly DomainFailureCode[]>;

export const sessionBlockingRequestFailureCodes = requestToolFailureCodes.session_ask;
export const sessionRequestSendFailureCodes = requestToolFailureCodes.session_request_send;
export const sessionRespondFailureCodes = requestToolFailureCodes.session_respond;
export const sessionSignalFailureCodes = requestToolFailureCodes.session_signal;
export const sessionRequestListFailureCodes = requestToolFailureCodes.session_request_list;
export const sessionRequestGetFailureCodes = requestToolFailureCodes.session_request_get;
export const sessionRequestAckFailureCodes = requestToolFailureCodes.session_request_ack;
export const sessionRequestCancelFailureCodes = requestToolFailureCodes.session_request_cancel;
