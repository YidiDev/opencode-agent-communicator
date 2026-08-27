import { expect, test } from "bun:test";
import { unavailableSessionExporter } from "../../../src/composition/unavailable-exporter";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateExportDestination } from "../../../src/domain/session-export";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

test("unconfigured export fails in isolation with the exact stable code", async () => {
  const session = validateSessionId("ses_0123456789abcdef0123456789abcdef");
  const workspace = validateWorkspaceKey("workspace");
  const destination = validateExportDestination("session.json");
  const token = validateFencingToken(1);
  if (!session.ok || !workspace.ok || !destination.ok || !token.ok) {
    throw new Error("Invalid export fixture.");
  }
  const result = await unavailableSessionExporter.writeExport({
    sessionId: session.value,
    sourceSessionId: session.value,
    workspaceKey: workspace.value,
    destination: destination.value,
    isSanitized: true,
    shouldOverwrite: false,
    abort: new AbortController().signal,
    deadlineMs: Date.now() + 1_000,
    fencingToken: token.value,
    guard: { check: async () => "current" },
  });
  expect(result).toEqual({ ok: false, code: "export_unavailable" });
});
