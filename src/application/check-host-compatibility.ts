import {
  type CompatibleHost,
  type HostHealthPort,
  isSupportedOpenCodeVersion,
  type RuntimeIdentityPort,
  supportedRuntimeArchitecture,
  supportedRuntimePlatform,
} from "../domain/host";
import { type DomainResult, domainFailure } from "../domain/results";
import { boundedExternalCall } from "./bounded-external-call";
import { deadlineLinkedSignal } from "./claimed-message-admission";

function incompatibleHost(): DomainResult<never> {
  return domainFailure(
    "incompatible_host",
    "The communicator requires Linux x64 and a healthy OpenCode >=1.18.21 <1.19.0 host.",
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

function supportedHealthVersion(value: unknown): CompatibleHost["version"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Reflect.get(value, "healthy") !== true) return undefined;
  const version = Reflect.get(value, "version");
  return isSupportedOpenCodeVersion(version) ? version : undefined;
}

export async function checkHostCompatibility(
  runtimeIdentity: RuntimeIdentityPort,
  healthPort: HostHealthPort,
  context?: Readonly<{ readonly abort: AbortSignal; readonly deadlineMs: number }>,
): Promise<DomainResult<CompatibleHost>> {
  try {
    if (!isExactSupportedRuntime(runtimeIdentity.readIdentity())) return incompatibleHost();
    const abortAwareHealth = healthPort as HostHealthPort & {
      readHealth(signal?: AbortSignal): Promise<unknown>;
    };
    const effect = context ? deadlineLinkedSignal(context.abort, context.deadlineMs) : undefined;
    const health = context
      ? await boundedExternalCall(
          () => abortAwareHealth.readHealth(effect?.signal),
          effect?.signal ?? context.abort,
          context.deadlineMs,
        ).finally(() => effect?.dispose())
      : { kind: "value" as const, value: await healthPort.readHealth() };
    const version = health.kind === "value" ? supportedHealthVersion(health.value) : undefined;
    if (!version) return incompatibleHost();
    return { ok: true, value: { version } };
  } catch (_cause: unknown) {
    return incompatibleHost();
  }
}
