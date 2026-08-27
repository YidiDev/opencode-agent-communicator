import {
  type CompatibleHost,
  type HostHealthPort,
  type RuntimeIdentityPort,
  supportedOpenCodeVersion,
  supportedRuntimeArchitecture,
  supportedRuntimePlatform,
} from "../domain/host";
import { type DomainResult, domainFailure } from "../domain/results";
import { boundedExternalCall } from "./bounded-external-call";

function incompatibleHost(): DomainResult<never> {
  return domainFailure(
    "incompatible_host",
    "The communicator requires Linux x64 and a healthy OpenCode 1.18.21 host.",
    false,
  );
}

function isExactSupportedRuntime(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    Reflect.get(value, "platform") === supportedRuntimePlatform &&
    Reflect.get(value, "architecture") === supportedRuntimeArchitecture
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
  runtimeIdentity: RuntimeIdentityPort,
  healthPort: HostHealthPort,
  context?: Readonly<{ readonly abort: AbortSignal; readonly deadlineMs: number }>,
): Promise<DomainResult<CompatibleHost>> {
  try {
    if (!isExactSupportedRuntime(runtimeIdentity.readIdentity())) return incompatibleHost();
    const health = context
      ? await boundedExternalCall(() => healthPort.readHealth(), context.abort, context.deadlineMs)
      : { kind: "value" as const, value: await healthPort.readHealth() };
    if (health.kind !== "value" || !isExactSupportedHealth(health.value)) {
      return incompatibleHost();
    }
    return { ok: true, value: { version: supportedOpenCodeVersion } };
  } catch (_cause: unknown) {
    return incompatibleHost();
  }
}
