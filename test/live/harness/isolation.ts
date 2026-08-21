import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { alternateTestModelID, testModelID, testProviderID } from "./constants";

export interface IsolatedOpenCodeState {
  readonly root: string;
  readonly project: string;
  readonly alternateProject: string;
  readonly evidencePath: string;
  readonly skillPath: string;
  readonly environment: Readonly<Record<string, string>>;
  remove(): Promise<void>;
}

export type IsolationSetupStage = "after-root" | "after-directories" | "after-config";

interface IsolationOptions {
  readonly providerBaseUrl: string;
  readonly pluginPath: string;
  readonly setupOperation?: (input: {
    readonly stage: IsolationSetupStage;
    readonly root: string;
  }) => void | Promise<void>;
}

async function makePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function initializeIsolatedOpenCodeState(
  root: string,
  options: IsolationOptions,
): Promise<IsolatedOpenCodeState> {
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
    alternateProject: join(root, "alternate-project"),
  };
  await Promise.all(Object.values(paths).map(makePrivateDirectory));
  await options.setupOperation?.({ stage: "after-directories", root });

  const evidencePath = join(root, "plugin-evidence.jsonl");
  const skillPath = join(root, "hook-skills");
  const skillDirectory = join(skillPath, "phase0-hook-skill");
  const controlSkillPath = join(root, "control-skills");
  const controlSkillDirectory = join(controlSkillPath, "phase0-control-skill");
  await makePrivateDirectory(skillDirectory);
  await makePrivateDirectory(controlSkillDirectory);
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: phase0-hook-skill\ndescription: Deterministic config-hook registration proof.\n---\n\n# Phase 0 hook skill\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(controlSkillDirectory, "SKILL.md"),
    "---\nname: phase0-control-skill\ndescription: Deterministic pre-start registration control.\n---\n\n# Phase 0 control skill\n",
    { mode: 0o600 },
  );
  const configPath = join(root, "opencode.json");
  const config = {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    formatter: false,
    lsp: false,
    model: `${testProviderID}/${testModelID}`,
    small_model: `${testProviderID}/${testModelID}`,
    agent: {
      build: { model: `${testProviderID}/${testModelID}`, mode: "primary" },
      alternate: { model: `${testProviderID}/${alternateTestModelID}`, mode: "primary" },
    },
    enabled_providers: [testProviderID],
    skills: { paths: [controlSkillPath] },
    tools: { diagnostic_context: true },
    plugin: [[pathToFileURL(options.pluginPath).href, { evidencePath, skillPath }]],
    permission: {
      live_allow: "allow",
      live_deny: "deny",
      live_ask: "ask",
    },
    provider: {
      [testProviderID]: {
        id: testProviderID,
        name: "Deterministic live test provider",
        env: ["LIVE_TEST_API_KEY"],
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
          [alternateTestModelID]: {
            id: alternateTestModelID,
            name: "Deterministic alternate model",
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
  const v2Config = {
    model: `${testProviderID}/${testModelID}`,
    default_agent: "build",
    agents: {
      build: { model: `${testProviderID}/${testModelID}`, mode: "primary" },
      alternate: { model: `${testProviderID}/${alternateTestModelID}`, mode: "primary" },
    },
    providers: {
      [testProviderID]: {
        name: "Deterministic live test provider",
        api: {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: options.providerBaseUrl,
        },
        request: { body: { apiKey: "local-test-key" } },
        models: {
          [testModelID]: {
            name: "Deterministic model",
            api: {
              id: testModelID,
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: options.providerBaseUrl,
            },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            request: { body: { apiKey: "local-test-key" } },
            cost: { input: 0, output: 0 },
            limit: { context: 100_000, output: 1_000 },
          },
          [alternateTestModelID]: {
            name: "Deterministic alternate model",
            api: {
              id: alternateTestModelID,
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: options.providerBaseUrl,
            },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            request: { body: { apiKey: "local-test-key" } },
            cost: { input: 0, output: 0 },
            limit: { context: 100_000, output: 1_000 },
          },
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 });
  await writeFile(
    join(paths.config, "opencode.json"),
    `${JSON.stringify(v2Config, undefined, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await options.setupOperation?.({ stage: "after-config", root });

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
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    LIVE_TEST_API_KEY: "local-test-key",
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
    alternateProject: paths.alternateProject,
    evidencePath,
    skillPath,
    environment,
    async remove(): Promise<void> {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export async function createIsolatedOpenCodeState(
  options: IsolationOptions,
): Promise<IsolatedOpenCodeState> {
  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), "opencode-communicator-live-"));
    await options.setupOperation?.({ stage: "after-root", root });
    return await initializeIsolatedOpenCodeState(root, options);
  } catch (error: unknown) {
    if (root !== undefined) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Preserve the setup failure; callers cannot act on a cleanup error instead.
      }
    }
    throw error;
  }
}
