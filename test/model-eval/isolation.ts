import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface EvaluationIsolation {
  readonly root: string;
  readonly project: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, unknown>>;
  remove(): Promise<void>;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function createEvaluationIsolation(
  entry: string,
  model: string,
): Promise<EvaluationIsolation> {
  const root = await mkdtemp(join(tmpdir(), "opencode-free-model-eval-"));
  await chmod(root, 0o700);
  const paths = {
    home: join(root, "home"),
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    state: join(root, "state"),
    temporary: join(root, "tmp"),
    project: join(root, "project"),
    pluginState: join(root, "plugin-state"),
  };
  await Promise.all(Object.values(paths).map(privateDirectory));
  const qualifiedModel = `opencode/${model}`;
  const config = {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    formatter: false,
    lsp: false,
    model: qualifiedModel,
    small_model: qualifiedModel,
    enabled_providers: ["opencode"],
    agent: { build: { mode: "primary", model: qualifiedModel } },
    plugin: [
      [
        pathToFileURL(dirname(entry)).href,
        {
          stateDirectory: paths.pluginState,
          policies: { message: "allow", ask: "allow", wait: "allow", start: "allow" },
        },
      ],
    ],
    permission: {
      "*": "allow",
      edit: "deny",
      bash: "deny",
      session_start: "allow",
      session_send: "allow",
      session_ask: "allow",
      session_wait: "allow",
      session_stop: "deny",
      session_export: "deny",
    },
  } satisfies Record<string, unknown>;
  const configPath = join(paths.config, "opencode.json");
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 });
  const environment = {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
    TMPDIR: paths.temporary,
    TMP: paths.temporary,
    TEMP: paths.temporary,
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: paths.config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  } satisfies Record<string, string>;
  return {
    root,
    project: paths.project,
    environment,
    config,
    async remove() {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
