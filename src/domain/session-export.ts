import type { Sha256Digest } from "./message-payload";
import type { SessionId } from "./sessions";

export type ExportDestination = string & { readonly exportDestination: unique symbol };

export const exportDestinationLimits = Object.freeze({
  maximumBytes: 1_024,
  maximumComponentBytes: 255,
  maximumComponents: 32,
});

const exportStageComponentPattern = /^\.session-export-[a-f0-9]{32}\.stage$/;
export const exportStageDirectoryName = ".session-export-staging";

export function isReservedExportPathComponent(value: string): boolean {
  return value === exportStageDirectoryName || exportStageComponentPattern.test(value);
}

export interface SessionExportRequest {
  readonly sessionId: SessionId;
  readonly destination: ExportDestination;
  readonly isSanitized: boolean;
  readonly shouldOverwrite: boolean;
}

export interface SessionExportSummary {
  readonly sessionId: SessionId;
  readonly destination: ExportDestination;
  readonly isSanitized: boolean;
  readonly byteCount: number;
  readonly contentSha256: Sha256Digest;
}

export type ExportPolicyDecision = "allow" | "ask" | "deny";

export interface SessionExportPolicy {
  readonly selfSanitized: ExportPolicyDecision;
  readonly crossSession: ExportPolicyDecision;
  readonly unsanitized: ExportPolicyDecision;
  readonly overwrite: ExportPolicyDecision;
}

export function createSessionExportPolicy(
  input: Partial<SessionExportPolicy> = {},
): SessionExportPolicy {
  const valid = (value: unknown): value is ExportPolicyDecision =>
    value === "allow" || value === "ask" || value === "deny";
  for (const value of Object.values(input)) {
    if (!valid(value)) throw new TypeError("Export policy contains an unsupported decision.");
  }
  return Object.freeze({
    selfSanitized: input.selfSanitized ?? "allow",
    crossSession: input.crossSession ?? "ask",
    unsanitized: input.unsanitized ?? "ask",
    overwrite: input.overwrite ?? "ask",
  });
}

export type ExportDestinationValidation =
  | { readonly ok: true; readonly value: ExportDestination; readonly components: readonly string[] }
  | { readonly ok: false; readonly message: string };

function hasUnsafeCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

export function validateExportDestination(value: unknown): ExportDestinationValidation {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, message: "Export destination must be a non-empty relative path." };
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) {
    return { ok: false, message: "Export destination must be relative." };
  }
  if (hasUnsafeCharacter(value) || value.includes("\\")) {
    return { ok: false, message: "Export destination contains unsafe characters." };
  }
  const components = value.split("/");
  if (
    components.length > exportDestinationLimits.maximumComponents ||
    components.some(
      (component) =>
        component === "" ||
        component === "." ||
        component === ".." ||
        isReservedExportPathComponent(component),
    )
  ) {
    return { ok: false, message: "Export destination contains an unsafe path component." };
  }
  const encoder = new TextEncoder();
  if (
    encoder.encode(value).byteLength > exportDestinationLimits.maximumBytes ||
    components.some(
      (component) =>
        encoder.encode(component).byteLength > exportDestinationLimits.maximumComponentBytes,
    )
  ) {
    return { ok: false, message: "Export destination exceeds its byte limit." };
  }
  return {
    ok: true,
    value: value as ExportDestination,
    components: Object.freeze([...components]),
  };
}
