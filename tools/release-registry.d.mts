export interface PublishedMetadata {
  readonly name: string;
  readonly version: string;
  readonly dist: {
    readonly integrity: string;
    readonly tarball: string;
    readonly attestations: { readonly provenance: { readonly predicateType: string } };
  };
}
export function assertPublishedArtifact(metadata: unknown, bytes: Uint8Array): void;
export function inspectRegistry(
  version: string,
  bytes: Uint8Array,
  request?: (input: string, options: RequestInit) => Promise<Response>,
): Promise<
  | { readonly state: "absent" }
  | { readonly state: "published"; readonly metadata: PublishedMetadata }
>;
