export type ExportData = Record<string, unknown>;

export function exportRecord(value: unknown): ExportData | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as ExportData) : undefined;
}

export function exportKeys(
  value: ExportData,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const present = Object.keys(value);
  return (
    required.every((key) => present.includes(key)) &&
    present.every((key) => required.includes(key) || optional.includes(key))
  );
}

export const isExportString = (value: unknown): value is string => typeof value === "string";
export const isExportNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const isExportBoolean = (value: unknown): value is boolean => typeof value === "boolean";
