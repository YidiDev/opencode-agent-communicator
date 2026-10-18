import { createSessionExportLimits } from "../adapters/export/export-limits";
import { LinuxExportRoot } from "../adapters/export/linux-export-destination";
import { assertLinuxSyscallsAvailable } from "../adapters/export/linux-syscalls";
import { SanitizedContextExportAdapter } from "../adapters/export/sanitized-context-export-adapter";
import type { SessionExportAdapterPort } from "../application/session-export-ports";
import type { NativeSessionReadPort } from "../application/session-read-ports";
import type { CommunicatorOptions } from "./config";
import { unavailableSessionExporter } from "./unavailable-exporter";

export function createProductionExporter(
  options: CommunicatorOptions,
  input: { readonly native: NativeSessionReadPort },
): {
  readonly adapter: SessionExportAdapterPort;
  readonly drain?: () => Promise<void>;
  readonly dispose?: () => void;
} {
  const configured = options.export;
  if (!configured?.root) {
    return { adapter: unavailableSessionExporter };
  }
  const limits = configured.limits;
  const adapterLimits = limits
    ? createSessionExportLimits({
        ...(limits.maximumOutputBytes === undefined
          ? {}
          : { maximumOutputBytes: limits.maximumOutputBytes }),
        ...(limits.maximumConcurrent === undefined
          ? {}
          : { maximumConcurrent: limits.maximumConcurrent }),
        ...(limits.maximumSourceExportsPerMinute === undefined
          ? {}
          : { maximumSourceExportsPerMinute: limits.maximumSourceExportsPerMinute }),
        ...(limits.maximumWorkspaceExportsPerMinute === undefined
          ? {}
          : { maximumWorkspaceExportsPerMinute: limits.maximumWorkspaceExportsPerMinute }),
      })
    : undefined;
  let root: LinuxExportRoot | undefined;
  try {
    assertLinuxSyscallsAvailable();
    root = LinuxExportRoot.open(configured.root);
    const adapter = new SanitizedContextExportAdapter(root, input.native, adapterLimits);
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
