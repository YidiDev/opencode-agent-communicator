export const minimumSupportedOpenCodeVersion = "1.18.21" as const;
export const supportedOpenCodeVersionRange = ">=1.18.21 <1.19.0" as const;
export const supportedRuntimePlatform = "linux" as const;
export const supportedRuntimeArchitecture = "x64" as const;
export const supportedBunVersion = "1.4.0" as const;

export type SupportedOpenCodeVersion = `1.18.${number}`;

export function isSupportedOpenCodeVersion(value: unknown): value is SupportedOpenCodeVersion {
  if (typeof value !== "string") return false;
  const match = /^1\.18\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return false;
  const patch = Number(match[1]);
  return Number.isSafeInteger(patch) && patch >= 21;
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
