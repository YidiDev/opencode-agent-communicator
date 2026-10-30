const configuredOpenCodeVersion = process.env.OPENCODE_COMPAT_VERSION ?? "2.1.3";
if (configuredOpenCodeVersion !== "2.1.3" && configuredOpenCodeVersion !== "2.2.2") {
  throw new Error("OPENCODE_COMPAT_VERSION must be a certified matrix release (2.1.3 or 2.2.2)");
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
