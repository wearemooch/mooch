// Builds the `codex app-server` command line that routes all model calls through FCC.
// Ported from FCC's harnesses/codex.py (codex_config_values / prepare_codex_launch), but the
// proxy token is passed through an environment variable instead of an auth command.
import path from 'node:path';

export const FCC_PROVIDER_ID = 'fcc';
export const FCC_TOKEN_ENV = 'FREE_CODE_FCC_TOKEN';

// FCC strips these so a user's own OpenAI/Codex setup cannot redirect the agent.
const STRIPPED_KEYS = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'CODEX_API_KEY',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_SHELL',
  'CODEX_THREAD_ID',
  'CODEX_HOME',
]);

export interface CodexLaunchOptions {
  codexBinary: string;
  fccUrl: string; // e.g. http://127.0.0.1:51234
  fccToken: string;
  modelCatalogPath: string;
  codexHome: string;
  baseEnv: NodeJS.ProcessEnv;
  /** Compact automatically past this many tokens of context; 0 or unset = the engine's default. */
  autoCompactTokens?: number;
  /** mooch's instructions for writing the compaction summary. */
  compactPrompt?: string;
}

export interface CodexLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function override(key: string, value: string): string[] {
  // `-c` values are parsed as TOML; a JSON string literal is a valid TOML basic string.
  return ['-c', `${key}=${JSON.stringify(value)}`];
}

export const DISABLED_FEATURES = [
  'apps',
  'plugins',
  'plugin_sharing',
  'remote_plugin',
  'recommended_plugins',
  'tool_suggest',
  'in_app_updates',
  'in_app_browser',
  'in_app_chat',
  'in_app_voice',
  'in_app_dictation',
  'in_app_local_automation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'browser_annotation_api',
  'computer_use',
  'image_generation',
  'realtime_conversation',
  'daemon_auto_start',
];

export function buildCodexLaunch(options: CodexLaunchOptions): CodexLaunch {
  const args = [
    'app-server',
    ...override('model_provider', FCC_PROVIDER_ID),
    ...override(`model_providers.${FCC_PROVIDER_ID}.name`, 'mooch model gateway'),
    ...override(`model_providers.${FCC_PROVIDER_ID}.base_url`, `${options.fccUrl.replace(/\/$/, '')}/v1`),
    ...override(`model_providers.${FCC_PROVIDER_ID}.wire_api`, 'responses'),
    ...override(`model_providers.${FCC_PROVIDER_ID}.env_key`, FCC_TOKEN_ENV),
    // FCC already retries and falls back across models, so Codex should fail fast.
    '-c',
    `model_providers.${FCC_PROVIDER_ID}.request_max_retries=1`,
    '-c',
    `model_providers.${FCC_PROVIDER_ID}.stream_max_retries=1`,
    // A reply that goes quiet mid-stream is dropped and retried after 90s instead of Codex's default 5 minutes.
    // (A model that never starts is handled by the proxy in llm/hedge.ts.)
    '-c',
    `model_providers.${FCC_PROVIDER_ID}.stream_idle_timeout_ms=90000`,
    ...override('model_catalog_json', path.resolve(options.modelCatalogPath)),
    // Codex would tell the model "sandbox_mode is read-only" (in its permissions message and again as a
    // read-only permission profile in <environment_context>). That sandbox is only how mooch routes
    // writes through its own approvals, but models took it literally and refused to edit. The master
    // prompt describes the real permissions and the environment (folder, shell, OS, date) instead.
    '-c',
    'include_permissions_instructions=false',
    '-c',
    'include_environment_context=false',
    // No usage analytics, feedback uploads or update checks to OpenAI: the app only talks to the
    // model providers the user added keys for.
    '-c',
    'analytics.enabled=false',
    '-c',
    'feedback.enabled=false',
    '-c',
    'check_for_update_on_startup=false',
    // Engine features that fetch from chatgpt.com/openai.com (plugin and app catalogs, update checks) or
    // need an OpenAI account (hosted browser/computer use, image generation, realtime voice). MCP stays on.
    ...DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
    ...(options.autoCompactTokens ? ['-c', `model_auto_compact_token_limit=${Math.round(options.autoCompactTokens)}`] : []),
    ...(options.compactPrompt ? override('compact_prompt', options.compactPrompt) : []),
  ];

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(options.baseEnv)) {
    if (STRIPPED_KEYS.has(key.toUpperCase()) || key.toUpperCase().startsWith('OPENAI_')) continue;
    env[key] = value;
  }
  env.CODEX_HOME = options.codexHome;
  env[FCC_TOKEN_ENV] = options.fccToken;

  return { command: options.codexBinary, args, env };
}
