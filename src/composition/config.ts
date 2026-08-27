import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { sessionExportHardLimits } from "../adapters/export/export-limits";
import type { SqliteStoreLimits } from "../adapters/store/store-types";
import type { PolicyDecision } from "../domain/authorization-policy";
import {
  startOperationsPerWorkspaceHardCeiling,
  startPayloadBytesPerWorkspaceHardCeiling,
  startTerminalRetentionMsHardCeiling,
  unresolvedStartProvenancePerWorkspaceHardCeiling,
} from "../domain/safety-ceilings";

const decision = z.enum(["allow", "ask", "deny"]);
const positiveInteger = (maximum: number) => z.number().int().min(1).max(maximum);
const absolutePath = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (!isAbsolute(value) || normalize(value) !== value || value === "/" || value.includes("\0")) {
      context.addIssue({ code: "custom", message: "Path must be a normalized absolute path." });
    }
  });

const startSchema = z
  .object({
    allowedAgents: z.array(z.string().min(1).max(128)).max(128).optional(),
    allowedModels: z.array(z.string().min(1).max(128)).max(128).optional(),
    allowManagedSessionRecursion: z.boolean().optional(),
    limits: z
      .object({
        managedSessionsPerWorkspace: positiveInteger(1_024).optional(),
        unresolvedProvenancePerWorkspace: positiveInteger(
          unresolvedStartProvenancePerWorkspaceHardCeiling,
        ).optional(),
        operationsPerWorkspace: positiveInteger(startOperationsPerWorkspaceHardCeiling).optional(),
        payloadBytesPerWorkspace: positiveInteger(
          startPayloadBytesPerWorkspaceHardCeiling,
        ).optional(),
        startsPerSourceWindow: positiveInteger(100).optional(),
        startsPerWorkspaceWindow: positiveInteger(1_000).optional(),
        rateWindowMs: positiveInteger(3_600_000).optional(),
        terminalRetentionMs: positiveInteger(startTerminalRetentionMsHardCeiling).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const exportLimitsSchema = z
  .object({
    maximumOutputBytes: positiveInteger(sessionExportHardLimits.maximumOutputBytes).optional(),
    maximumStderrBytes: positiveInteger(sessionExportHardLimits.maximumStderrBytes).optional(),
    maximumDurationMs: positiveInteger(sessionExportHardLimits.maximumDurationMs).optional(),
    maximumConcurrent: positiveInteger(sessionExportHardLimits.maximumConcurrent).optional(),
    terminationGraceMs: positiveInteger(5_000).optional(),
    maximumSourceExportsPerMinute: positiveInteger(
      sessionExportHardLimits.maximumSourceExportsPerMinute,
    ).optional(),
    maximumWorkspaceExportsPerMinute: positiveInteger(
      sessionExportHardLimits.maximumWorkspaceExportsPerMinute,
    ).optional(),
  })
  .strict();

const exportSchema = z
  .object({
    root: absolutePath.optional(),
    executable: absolutePath.optional(),
    trustedWorkingDirectory: absolutePath.optional(),
    limits: exportLimitsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const configured = [value.root, value.executable, value.trustedWorkingDirectory];
    if (
      configured.some((item) => item !== undefined) &&
      configured.some((item) => item === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Export root, executable, and trustedWorkingDirectory must be configured together.",
      });
    }
  });

const optionsSchema = z
  .object({
    stateDirectory: absolutePath.optional(),
    startupDeadlineMs: positiveInteger(60_000).optional(),
    invocationDeadlineMs: positiveInteger(3_600_000).optional(),
    policies: z
      .object({
        message: decision.optional(),
        ask: decision.optional(),
        wait: decision.optional(),
        start: decision.optional(),
        exportSelfSanitized: decision.optional(),
        exportCrossSession: decision.optional(),
        exportUnsanitized: decision.optional(),
        exportOverwrite: decision.optional(),
      })
      .strict()
      .optional(),
    start: startSchema.optional(),
    export: exportSchema.optional(),
  })
  .strict();

export type { PolicyDecision };
export type CommunicatorOptions = z.infer<typeof optionsSchema> & {
  readonly stateDirectory: string;
  readonly startupDeadlineMs: number;
  readonly invocationDeadlineMs: number;
};

function defaultStateDirectory(environment: NodeJS.ProcessEnv): string {
  const base =
    environment.XDG_STATE_HOME ??
    (environment.HOME ? join(environment.HOME, ".local/state") : undefined);
  if (!base || !isAbsolute(base))
    throw new TypeError("A private absolute stateDirectory is required.");
  return join(base, "opencode-agent-communicator");
}

function assertDedicatedRoot(path: string, environment: NodeJS.ProcessEnv, label: string): void {
  const broad = new Set(
    [
      "/etc",
      "/usr",
      "/var",
      "/opt",
      "/tmp",
      "/home",
      "/root",
      environment.HOME,
      environment.XDG_STATE_HOME,
      environment.XDG_DATA_HOME,
    ].filter((value): value is string => typeof value === "string"),
  );
  if (broad.has(path)) throw new TypeError(`${label} must be a dedicated application root.`);
}

/** Strict public PluginOptions parser. Store construction performs descriptor-based path trust checks. */
export function parseCommunicatorOptions(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): CommunicatorOptions {
  const parsed = optionsSchema.parse(input ?? {});
  const stateDirectory = parsed.stateDirectory ?? defaultStateDirectory(environment);
  assertDedicatedRoot(stateDirectory, environment, "stateDirectory");
  if (parsed.export?.root) assertDedicatedRoot(parsed.export.root, environment, "export.root");
  return Object.freeze({
    ...parsed,
    stateDirectory,
    startupDeadlineMs: parsed.startupDeadlineMs ?? 30_000,
    invocationDeadlineMs: parsed.invocationDeadlineMs ?? 3_600_000,
  });
}

export type StoreLimitOverrides = Partial<SqliteStoreLimits>;
