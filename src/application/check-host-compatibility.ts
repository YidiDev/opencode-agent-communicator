import { type CompatibleHost, type HostHealthPort, supportedOpenCodeVersion } from "../domain/host";
import { type DomainResult, domainFailure } from "../domain/results";

function incompatibleHost(): DomainResult<never> {
  return domainFailure(
    "incompatible_host",
    "The communicator requires a healthy OpenCode 1.18.21 host.",
    false,
  );
}

function isExactSupportedHealth(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    Reflect.get(value, "healthy") === true &&
    Reflect.get(value, "version") === supportedOpenCodeVersion
  );
}

export async function checkHostCompatibility(
  healthPort: HostHealthPort,
): Promise<DomainResult<CompatibleHost>> {
  try {
    if (!isExactSupportedHealth(await healthPort.readHealth())) return incompatibleHost();
    return { ok: true, value: { version: supportedOpenCodeVersion } };
  } catch (_cause: unknown) {
    return incompatibleHost();
  }
}
