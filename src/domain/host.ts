export const minimumSupportedOpenCodeVersion = "2.1.3" as const;
export const supportedOpenCodeVersionRange = ">=2.1.3 <2.3.0" as const;
export const supportedRuntimePlatform = "linux" as const;
export const supportedRuntimeArchitecture = "x64" as const;
export const supportedBunVersion = "1.4.0" as const;

export type SupportedOpenCodeVersion = `2.${1 | 2}.${number}`;

export function parseSupportedOpenCodeVersion(
  value: unknown,
): SupportedOpenCodeVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^2\.(1|2)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  const patch = Number(match[2]);
  return Number.isSafeInteger(patch) && (match[1] === "2" || patch >= 3)
    ? (value as SupportedOpenCodeVersion)
    : undefined;
}

export function isSupportedOpenCodeVersion(value: unknown): value is SupportedOpenCodeVersion {
  return parseSupportedOpenCodeVersion(value) !== undefined;
}

export interface HostHealthPort {
  readHealth(): Promise<unknown>;
}

export interface RuntimeIdentityPort {
  readIdentity(): unknown;
}

export interface CompatibleHost {
  readonly version: SupportedOpenCodeVersion;
}
