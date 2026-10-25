export interface ReleaseVersion {
  readonly version: string;
  readonly tag: string;
  readonly prerelease: boolean;
  readonly distTag: "next" | "latest";
}
export function releaseVersion(value: unknown): ReleaseVersion;
export function assertStableReadiness(version: unknown, readiness: unknown, digest: string): void;
export function runtimeDigest(root: string): Promise<string>;
