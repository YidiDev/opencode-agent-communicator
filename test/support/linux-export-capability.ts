import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinuxExportRoot } from "../../src/adapters/export/linux-export-destination";

function probe(): boolean {
  if (process.platform !== "linux") return false;
  const base = mkdtempSync(join(tmpdir(), "communicator-export-probe-"));
  chmodSync(base, 0o700);
  try {
    using root = LinuxExportRoot.open(join(base, "exports"));
    const temporary = root.createTemporary("probe", "f".repeat(32));
    temporary.write(new Uint8Array([1]));
    temporary.install(false);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export const hasLinuxDescriptorInstall = probe();

if (process.env.REQUIRE_SECURE_EXPORT_CAPABILITY === "1" && !hasLinuxDescriptorInstall) {
  throw new Error(
    "Required Linux O_TMPFILE/AT_EMPTY_PATH/renameat2 secure-export capability is unavailable.",
  );
}
