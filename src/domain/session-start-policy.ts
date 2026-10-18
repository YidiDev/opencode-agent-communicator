import {
  managedSessionsPerWorkspaceHardCeiling,
  startOperationsPerWorkspaceHardCeiling,
  startPayloadBytesPerWorkspaceHardCeiling,
  startsPerSourceWindowHardCeiling,
  startsPerWorkspaceWindowHardCeiling,
  startTerminalRetentionMsHardCeiling,
  unresolvedStartProvenancePerWorkspaceHardCeiling,
} from "./safety-ceilings";

export interface SessionStartPolicy {
  readonly decision: "allow" | "deny";
  readonly allowedAgents: ReadonlySet<string>;
  readonly allowedModels: ReadonlySet<string>;
  readonly allowManagedSessionRecursion: boolean;
  readonly limits: {
    readonly managedSessionsPerWorkspace: number;
    readonly unresolvedProvenancePerWorkspace: number;
    readonly operationsPerWorkspace: number;
    readonly payloadBytesPerWorkspace: number;
    readonly startsPerSourceWindow: number;
    readonly startsPerWorkspaceWindow: number;
    readonly rateWindowMs: number;
    readonly terminalRetentionMs: number;
  };
}

export interface SessionStartPolicyInput {
  readonly decision?: "allow" | "deny";
  readonly allowedAgents?: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly allowManagedSessionRecursion?: boolean;
  readonly limits?: Partial<SessionStartPolicy["limits"]>;
}

function bounded(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is outside its immutable safety ceiling.`);
  }
  return value;
}

function exactSet(values: readonly string[] | undefined, label: string): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || result.has(value)) {
      throw new TypeError(`${label} must contain unique bounded strings.`);
    }
    result.add(value);
  }
  return result;
}

export function createSessionStartPolicy(input: SessionStartPolicyInput = {}): SessionStartPolicy {
  const limits = input.limits ?? {};
  return Object.freeze({
    decision: input.decision ?? "deny",
    allowedAgents: exactSet(input.allowedAgents, "allowedAgents"),
    allowedModels: exactSet(input.allowedModels, "allowedModels"),
    allowManagedSessionRecursion: input.allowManagedSessionRecursion ?? false,
    limits: Object.freeze({
      managedSessionsPerWorkspace: bounded(
        limits.managedSessionsPerWorkspace ?? 64,
        managedSessionsPerWorkspaceHardCeiling,
        "managedSessionsPerWorkspace",
      ),
      unresolvedProvenancePerWorkspace: bounded(
        limits.unresolvedProvenancePerWorkspace ?? 16,
        unresolvedStartProvenancePerWorkspaceHardCeiling,
        "unresolvedProvenancePerWorkspace",
      ),
      operationsPerWorkspace: bounded(
        limits.operationsPerWorkspace ?? 4_096,
        startOperationsPerWorkspaceHardCeiling,
        "operationsPerWorkspace",
      ),
      payloadBytesPerWorkspace: bounded(
        limits.payloadBytesPerWorkspace ?? 8 * 1_024 * 1_024,
        startPayloadBytesPerWorkspaceHardCeiling,
        "payloadBytesPerWorkspace",
      ),
      startsPerSourceWindow: bounded(
        limits.startsPerSourceWindow ?? 5,
        startsPerSourceWindowHardCeiling,
        "startsPerSourceWindow",
      ),
      startsPerWorkspaceWindow: bounded(
        limits.startsPerWorkspaceWindow ?? 25,
        startsPerWorkspaceWindowHardCeiling,
        "startsPerWorkspaceWindow",
      ),
      rateWindowMs: bounded(limits.rateWindowMs ?? 60_000, 3_600_000, "rateWindowMs"),
      terminalRetentionMs: bounded(
        limits.terminalRetentionMs ?? 24 * 60 * 60 * 1_000,
        startTerminalRetentionMsHardCeiling,
        "terminalRetentionMs",
      ),
    }),
  });
}
