export const supportedOpenCodeVersion = "1.18.21" as const;

export type SupportedOpenCodeVersion = typeof supportedOpenCodeVersion;

export interface HostHealthPort {
  readHealth(): Promise<unknown>;
}

export interface CompatibleHost {
  readonly version: SupportedOpenCodeVersion;
}
