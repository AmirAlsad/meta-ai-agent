/**
 * Load the bot's config from `config.yaml` (sibling of `src/`), apply env
 * overrides, and fail fast if no provider key is configured.
 *
 * Env overrides (take precedence over config.yaml):
 *   SHOWCASE_MODEL  → model        (registry-prefixed, e.g. `anthropic:claude-sonnet-4-6`)
 *   MAX_TOKENS      → maxTokens
 *   PORT            → port
 * Provider keys are read straight from the environment by the AI SDK providers
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY) and by the STT layer (GROQ_API_KEY);
 * here we only assert that the key for the SELECTED provider is present.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BotConfig {
  port: number;
  /** Registry-prefixed model id, e.g. `anthropic:claude-sonnet-4-6`. */
  model: string;
  maxTokens: number;
  maxSteps: number;
  systemPrompt: string;
}

/** Substitute `${ENV_VAR}` occurrences inside config.yaml string values. */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)}/g, (_, name) => process.env[name] ?? '');
}

function resolveDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveDeep);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = resolveDeep(val);
    }
    return result;
  }
  return obj;
}

export function loadConfig(): BotConfig {
  const configPath = resolve(__dirname, '..', 'config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const resolved = resolveDeep(parsed) as Record<string, unknown>;

  const config: BotConfig = {
    port: Number(process.env.PORT ?? (resolved.port as number) ?? 4055),
    model: process.env.SHOWCASE_MODEL ?? (resolved.model as string) ?? 'anthropic:claude-sonnet-4-6',
    maxTokens: Number(process.env.MAX_TOKENS ?? (resolved.maxTokens as number) ?? 1024),
    maxSteps: (resolved.maxSteps as number) ?? 5,
    systemPrompt: (resolved.systemPrompt as string) ?? 'You are a helpful assistant.'
  };

  assertProviderKey(config.model);
  return config;
}

/**
 * Fail fast if the key for the selected provider is missing. The model id is
 * registry-prefixed (`<provider>:<id>`), so the prefix tells us which key to
 * require. We only require the SELECTED provider's key — OPENAI_API_KEY is not
 * needed when running the default Anthropic model, and vice-versa.
 */
function assertProviderKey(model: string): void {
  const provider = model.split(':')[0];
  const required: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY'
  };
  const envName = required[provider ?? ''];
  if (!envName) {
    throw new Error(
      `Unknown model provider prefix in "${model}". Use a registry-prefixed id like ` +
        '"anthropic:claude-sonnet-4-6" or "openai:gpt-4o-mini".'
    );
  }
  const key = process.env[envName];
  if (!key || key.trim().length === 0) {
    throw new Error(
      `${envName} is not set, but the configured model "${model}" needs it. ` +
        `Set ${envName} in this package's .env (or your shell) before starting the bot.`
    );
  }
}
