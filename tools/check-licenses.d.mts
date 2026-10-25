export interface LicenseInventory {
  readonly schema_version: 1;
  readonly scope: string;
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly license: string;
    readonly package: string;
  }[];
}
export function licenseInventory(packages: unknown, rootName: string): LicenseInventory;
export function checkLicenses(root?: string, update?: boolean): Promise<void>;
