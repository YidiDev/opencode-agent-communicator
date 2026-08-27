export const supportedOpenCodeVersion = "1.18.21" as const;
export const supportedRuntimePlatform = "linux" as const;
export const supportedRuntimeArchitecture = "x64" as const;
export const supportedBunVersion = "1.4.0" as const;

export type SupportedOpenCodeVersion = typeof supportedOpenCodeVersion;

export interface HostHealthPort {
  readHealth(): Promise<unknown>;
}

export interface RuntimeIdentityPort {
  readIdentity(): unknown;
}

export interface CompatibleHost {
  readonly version: SupportedOpenCodeVersion;
}
