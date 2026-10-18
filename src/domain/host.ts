export const minimumSupportedOpenCodeVersion = "2.0.26" as const;
export const supportedOpenCodeVersionRange = ">=2.0.26 <2.1.0" as const;
export const supportedRuntimePlatform = "linux" as const;
export const supportedRuntimeArchitecture = "x64" as const;
export const supportedBunVersion = "1.4.0" as const;

export type SupportedOpenCodeVersion = `2.0.${number}`;

export function parseSupportedOpenCodeVersion(
  value: unknown,
): SupportedOpenCodeVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^2\.0\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  const patch = Number(match[1]);
  return Number.isSafeInteger(patch) && patch >= 26
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
