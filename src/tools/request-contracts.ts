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
import { validateSessionId } from "../domain/sessions";

export {
  requestToolFailureCodes,
  sessionBlockingRequestFailureCodes,
  sessionRequestAckFailureCodes,
  sessionRequestCancelFailureCodes,
  sessionRequestGetFailureCodes,
  sessionRequestListFailureCodes,
  sessionRequestSendFailureCodes,
  sessionRespondFailureCodes,
  sessionSignalFailureCodes,
} from "./request-failure-contracts";

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
      .array(
        z
          .array(z.string())
          .max(requestLimits.maximumAnswersPerQuestion)
          .describe("Selected or custom answers for one question."),
      )
      .min(requestLimits.minimumQuestions)
      .max(requestLimits.maximumQuestions)
      .describe('One inner answer array per question, in order; for example [["pass"]].'),
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
