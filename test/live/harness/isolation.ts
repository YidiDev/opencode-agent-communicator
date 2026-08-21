import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { testModelID, testProviderID } from "./constants";

export interface IsolatedOpenCodeState {
  readonly root: string;
  readonly project: string;
  readonly evidencePath: string;
  readonly environment: Readonly<Record<string, string>>;
  remove(): Promise<void>;
}

interface IsolationOptions {
  readonly providerBaseUrl: string;
  readonly pluginPath: string;
}

async function makePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function createIsolatedOpenCodeState(
  options: IsolationOptions,
): Promise<IsolatedOpenCodeState> {
  const root = await mkdtemp(join(tmpdir(), "opencode-communicator-live-"));
  await chmod(root, 0o700);
  const paths = {
    home: join(root, "home"),
    config: join(root, "xdg-config"),
    data: join(root, "xdg-data"),
    cache: join(root, "xdg-cache"),
    state: join(root, "xdg-state"),
    temporary: join(root, "tmp"),
    managed: join(root, "managed-config"),
    npmCache: join(root, "npm-cache"),
    project: join(root, "project"),
  };
  await Promise.all(Object.values(paths).map(makePrivateDirectory));

  const evidencePath = join(root, "plugin-evidence.jsonl");
  const configPath = join(root, "opencode.json");
  const config = {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    formatter: false,
    lsp: false,
    model: `${testProviderID}/${testModelID}`,
    small_model: `${testProviderID}/${testModelID}`,
    enabled_providers: [testProviderID],
    tools: { diagnostic_context: true },
    plugin: [[pathToFileURL(options.pluginPath).href, { evidencePath }]],
    provider: {
      [testProviderID]: {
        id: testProviderID,
        name: "Deterministic live test provider",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          [testModelID]: {
            id: testModelID,
            name: "Deterministic model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2026-01-01",
            limit: { context: 100_000, output: 1_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "local-test-key", baseURL: options.providerBaseUrl },
      },
    },
  };
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
    OPENCODE_TEST_HOME: paths.home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: paths.managed,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    npm_config_cache: paths.npmCache,
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  } satisfies Record<string, string>;
  if ("OPENCODE_PURE" in environment)
    throw new Error("live harness must exercise explicit plugins");

  return {
    root,
    project: paths.project,
    evidencePath,
    environment,
    async remove(): Promise<void> {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
