const configuredOpenCodeVersion = process.env.OPENCODE_COMPAT_VERSION ?? "1.18.25";
if (!/^1\.18\.(0|[1-9]\d*)$/.test(configuredOpenCodeVersion)) {
  throw new Error("OPENCODE_COMPAT_VERSION must be a stable OpenCode 1.18 patch");
}
export const exactOpenCodeVersion = configuredOpenCodeVersion;
export const diagnosticToolID = "diagnostic_context";
export const diagnosticProviderCallID = "call_live_diagnostic";
export const testProviderID = "live-test";
export const testModelID = "deterministic-model";
export const alternateTestModelID = "deterministic-model-alternate";
export const maximumCapturedProcessBytes = 1024 * 1024;
export const liveDeadlineMs = 30_000;
export const disposalDeadlineMs = 60_000;
