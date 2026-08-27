export const requestLimits = {
  minimumTimeoutSeconds: 1,
  maximumTimeoutSeconds: 3600,
  minimumQuestions: 1,
  maximumQuestions: 10,
  maximumOptionsPerQuestion: 20,
  maximumAnswersPerQuestion: 20,
  promptBytes: 8 * 1024,
  milestoneBytes: 8 * 1024,
  optionBytes: 4 * 1024,
  customAnswerBytes: 4 * 1024,
  evidenceBytes: 4 * 1024,
  canonicalContentBytes: 32 * 1024,
  envelopeBytes: 64 * 1024,
  resultRetentionMs: 24 * 60 * 60 * 1000,
} as const;

export const requestProtocol = "opencode-session-communicator/v1" as const;

/** Reserved before durable creation and after the durable deadline for bounded external I/O. */
export const blockingRequestDeadlineMarginMs = 30_000;
