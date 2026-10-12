import { z } from "zod";
import type { DomainFailureCode } from "../domain/results";
import { sessionReadLimits } from "../domain/session-read";
import { validateSessionId } from "../domain/sessions";

const sessionIdSchema = z.string().superRefine((value, context) => {
  const validation = validateSessionId(value);
  if (!validation.ok) context.addIssue({ code: "custom", message: validation.message });
});

export const sessionReadArgumentsSchema = z
  .object({
    session_id: sessionIdSchema,
    cursor: z
      .string()
      .min(1)
      .max(sessionReadLimits.maxCursorCharacters)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    direction: z.enum(["before", "after"]).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(sessionReadLimits.maxLines)
      .optional()
      .default(sessionReadLimits.defaultLines),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.direction !== undefined && value.cursor === undefined) {
      context.addIssue({
        code: "custom",
        path: ["direction"],
        message: "direction requires cursor.",
      });
    }
  });

export type SessionReadToolArguments = z.infer<typeof sessionReadArgumentsSchema>;

export const sessionReadFailureCodes = [
  "invalid_arguments",
  "caller_not_visible",
  "target_not_visible",
  "permission_denied",
  "deadline_expired",
  "native_unavailable",
  "cursor_stale",
] as const satisfies readonly DomainFailureCode[];
