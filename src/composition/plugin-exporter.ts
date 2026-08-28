import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginInput } from "@opencode-ai/plugin";
import { createSessionExportLimits } from "../adapters/export/export-limits";
import { LinuxExportRoot } from "../adapters/export/linux-export-destination";
import { assertLinuxSyscallsAvailable } from "../adapters/export/linux-syscalls";
import { OpenCodeCliExportAdapter } from "../adapters/export/opencode-cli-export-adapter";
import {
  allowlistedStateEnvironment,
  executableIdentity,
  trustedWorkingDirectory,
} from "../adapters/export/opencode-cli-trust";
import type { SessionExportAdapterPort } from "../application/session-export-ports";
import type { CommunicatorOptions } from "./config";
import { unavailableSessionExporter } from "./unavailable-exporter";

const bundledSkillsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");

export function productionExportEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return allowlistedStateEnvironment(environment);
}

export function createProductionExporter(
  options: CommunicatorOptions,
  input: PluginInput,
): {
  readonly adapter: SessionExportAdapterPort;
  readonly drain?: () => Promise<void>;
  readonly dispose?: () => void;
} {
  const configured = options.export;
  if (!configured?.root || !configured.executable || !configured.trustedWorkingDirectory) {
    return { adapter: unavailableSessionExporter };
  }
  const limits = configured.limits;
  const adapterConfiguration = {
    executablePath: configured.executable,
    workspaceDirectory: input.directory,
    trustedWorkingDirectory: configured.trustedWorkingDirectory,
    pluginDirectories: [dirname(bundledSkillsPath)],
    environment: productionExportEnvironment(),
    ...(limits
      ? {
          limits: createSessionExportLimits({
            ...(limits.maximumOutputBytes === undefined
              ? {}
              : { maximumOutputBytes: limits.maximumOutputBytes }),
            ...(limits.maximumStderrBytes === undefined
              ? {}
              : { maximumStderrBytes: limits.maximumStderrBytes }),
            ...(limits.maximumDurationMs === undefined
              ? {}
              : { maximumDurationMs: limits.maximumDurationMs }),
            ...(limits.maximumConcurrent === undefined
              ? {}
              : { maximumConcurrent: limits.maximumConcurrent }),
            ...(limits.terminationGraceMs === undefined
              ? {}
              : { terminationGraceMs: limits.terminationGraceMs }),
            ...(limits.maximumSourceExportsPerMinute === undefined
              ? {}
              : { maximumSourceExportsPerMinute: limits.maximumSourceExportsPerMinute }),
            ...(limits.maximumWorkspaceExportsPerMinute === undefined
              ? {}
              : { maximumWorkspaceExportsPerMinute: limits.maximumWorkspaceExportsPerMinute }),
          }),
        }
      : {}),
  };
  let root: LinuxExportRoot | undefined;
  try {
    assertLinuxSyscallsAvailable();
    // Trust checks are path-only and precede creation of the configured export root.
    executableIdentity(adapterConfiguration);
    trustedWorkingDirectory(adapterConfiguration);
    root = LinuxExportRoot.open(configured.root);
    const adapter = new OpenCodeCliExportAdapter(root, adapterConfiguration);
    return {
      adapter,
      drain: () => adapter.drain(),
      dispose: () => adapter[Symbol.dispose](),
    };
  } catch {
    root?.close();
    throw new Error("Session export secure initialization failed.");
  }
}
