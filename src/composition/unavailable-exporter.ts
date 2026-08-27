import type { SessionExportAdapterPort } from "../application/session-export-ports";

export const unavailableSessionExporter: SessionExportAdapterPort = Object.freeze({
  async writeExport() {
    return { ok: false as const, code: "export_unavailable" as const };
  },
});
