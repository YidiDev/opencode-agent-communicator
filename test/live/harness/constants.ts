const configuredOpenCodeVersion = process.env.OPENCODE_COMPAT_VERSION ?? "2.0.26";
if (configuredOpenCodeVersion !== "2.0.26") {
  throw new Error("OPENCODE_COMPAT_VERSION must equal the pinned OpenCode 2.0.26 release");
}
export const exactOpenCodeVersion = configuredOpenCodeVersion;
export const liveServerPassword = "live-test-password";
export const diagnosticToolID = "diagnostic_context";
export const diagnosticProviderCallID = "call_live_diagnostic";
export const testProviderID = "live-test";
export const testModelID = "deterministic-model";
export const alternateTestModelID = "deterministic-model-alternate";
export const maximumCapturedProcessBytes = 1024 * 1024;
export const liveDeadlineMs = 30_000;
export const disposalDeadlineMs = 60_000;
