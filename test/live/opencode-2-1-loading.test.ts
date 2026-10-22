import { expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { hasLinuxDescriptorInstall } from "../support/linux-export-capability";
import { liveDeadlineMs } from "./harness/constants";
import { invokePackedTool, launchPackedHost } from "./harness/production-host";

setDefaultTimeout(liveDeadlineMs * 4);

test("2.1 rejects a configured file before communicator setup instead of registering a failed plugin", async () => {
  const host = await launchPackedHost({ fileEntrypoint: true });
  let failure: unknown;
  try {
    const registry = await host.client.plugin.list({
      location: { directory: host.isolation.project },
    });
    expect(registry.data.some((plugin) => plugin.id === "opencode-agent-communicator")).toBe(false);
    expect(host.serve.stderr()).toContain("configured plugin path must be a directory");
    const configuration = await host.client.config.get({
      location: { directory: host.isolation.project },
    });
    expect(JSON.stringify(configuration)).toContain(`${host.packagePath}/index.ts`);
    await expect(
      stat(join(host.isolation.root, "xdg-state/opencode-agent-communicator")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } catch (cause) {
    failure = cause;
  } finally {
    await host.dispose(failure);
  }
});

test("2.1 loads the actual packed source directory and supports authorized start, reads, and sanitized export", async () => {
  const host = await launchPackedHost({
    pluginOptions: (root) => ({
      policies: { start: "allow", readCrossSession: "allow" },
      export: { root: join(root, "exports") },
    }),
  });
  let failure: unknown;
  try {
    expect(host.packagePath).toEndWith("node_modules/opencode-agent-communicator/src");
    const registry = await host.client.plugin.list({
      location: { directory: host.isolation.project },
    });
    expect(registry.data).toContainEqual(
      expect.objectContaining({ id: "opencode-agent-communicator", state: { status: "active" } }),
    );
    const source = await host.client.session.create({
      title: "Authorized v2.1 journey",
      agent: "build",
      model: { providerID: "live-test", id: "deterministic-model" },
      location: { directory: host.isolation.project },
    });
    const started = await invokePackedTool(
      host.client,
      source.id,
      "production-session-start",
      "session_start",
    );
    expect(started).toMatchObject({
      ok: true,
      value: { creation_state: "created", admission_state: "admitted" },
    });
    const target = started.value?.session_id;
    if (typeof target !== "string") throw new Error("missing created session identity");
    expect((await host.client.session.get({ sessionID: target })).parentID).toBeUndefined();
    expect(
      await invokePackedTool(host.client, source.id, "production-session-start", "session_start"),
    ).toEqual(started);
    await host.client.session.wait({ sessionID: target });
    const read = await invokePackedTool(
      host.client,
      source.id,
      `production-session-read-cross:${target}`,
      "session_read",
    );
    expect(read).toMatchObject({ ok: true, value: { session_id: target } });
    const cursor = read.value?.end_cursor;
    if (typeof cursor !== "string") throw new Error("missing current-context cursor");
    expect(
      await invokePackedTool(
        host.client,
        source.id,
        `production-session-read-after:${target}:${cursor}`,
        "session_read",
      ),
    ).toMatchObject({ ok: true, value: { session_id: target, content: "" } });
    const exported = await invokePackedTool(
      host.client,
      source.id,
      "production-export-sanitized",
      "session_export",
    );
    if (!hasLinuxDescriptorInstall) {
      expect(exported).toMatchObject({ ok: false, error: { code: "unsafe_path" } });
      await expect(stat(join(host.isolation.root, "exports/live.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      return;
    }
    expect(exported).toMatchObject({ ok: true, value: { session_id: source.id, sanitized: true } });
    const content = await readFile(join(host.isolation.root, "exports/live.json"));
    expect(exported.value).toMatchObject({
      byte_count: content.byteLength,
      content_sha256: createHash("sha256").update(content).digest("hex"),
    });
    const document = JSON.parse(content.toString());
    expect(document).toMatchObject({
      kind: "opencode-sanitized-current-context",
      history_complete: false,
    });
    expect(JSON.stringify(document)).not.toContain("production-export-sanitized");
    expect(
      await invokePackedTool(
        host.client,
        source.id,
        "production-export-sanitized",
        "session_export",
      ),
    ).toMatchObject({ ok: false, error: { code: "destination_exists" } });
  } catch (cause) {
    failure = cause;
  } finally {
    await host.dispose(failure);
  }
});
