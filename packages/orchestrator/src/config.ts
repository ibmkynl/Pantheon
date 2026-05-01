import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the pantheon.yaml path. Search order:
 *   1. $PANTHEON_CONFIG (explicit override)
 *   2. ./pantheon.yaml (CWD project-local)
 *   3. $PANTHEON_HOME/pantheon.yaml (defaults to ~/.pantheon/pantheon.yaml)
 *   4. <repo-root>/pantheon.yaml (legacy / dev)
 */
function resolveConfigPath(): string {
  const env = process.env['PANTHEON_CONFIG'];
  if (env && fs.existsSync(env)) return env;

  const cwdLocal = path.resolve(process.cwd(), 'pantheon.yaml');
  if (fs.existsSync(cwdLocal)) return cwdLocal;

  const home = process.env['PANTHEON_HOME'] || path.join(os.homedir(), '.pantheon');
  const homePath = path.join(home, 'pantheon.yaml');
  if (fs.existsSync(homePath)) return homePath;

  // Legacy: dist/index.js → 3 levels up to repo root
  const legacy = path.resolve(__dirname, '../../../pantheon.yaml');
  return legacy;
}

const CONFIG_PATH = resolveConfigPath();

const PluginSchema = z.object({
  name:      z.string(),
  transport: z.enum(['stdio', 'http']),
  command:   z.string().optional(),
  url:       z.string().optional(),
});

const ProviderConfigSchema = z.object({
  api_key:  z.string().optional(),
  base_url: z.string().optional(),
});

const ConfigSchema = z.object({
  ai: z.object({
    provider: z.string().optional(),
    api_key:  z.string().optional(),
    base_url: z.string().optional(),
    default_provider: z.string().optional(),
    providers: z.record(ProviderConfigSchema).optional(),
    models: z.object({
      router:     z.string().default('claude-haiku-4-5-20251001'),
      core:       z.string().default('claude-sonnet-4-6'),
      specialist: z.string().default('claude-opus-4-7'),
      btw:        z.string().default('claude-haiku-4-5-20251001'),
    }),
    agent_models: z.record(z.string()).optional(),
  }),
  mcp: z.object({
    port: z.number().default(3100),
    host: z.string().default('localhost'),
  }),
  orchestrator: z.object({
    port: z.number().default(3101),
    host: z.string().default('localhost'),
  }),
  limits: z.object({
    max_tokens_per_session:   z.number().default(500000),
    max_revision_loops:       z.number().default(2),
    max_parallel_specialists: z.number().default(3),
  }),
  plugins: z.array(PluginSchema).optional().default([]),
});

export type Config         = z.infer<typeof ConfigSchema>;
export type Plugin         = z.infer<typeof PluginSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  _config = ConfigSchema.parse(parse(raw));

  const c = _config;
  if (c.ai.api_key && !c.ai.providers?.['anthropic']) {
    c.ai.providers = { ...c.ai.providers, anthropic: { api_key: c.ai.api_key, base_url: c.ai.base_url } };
  }
  if (!c.ai.default_provider) {
    c.ai.default_provider = c.ai.provider ?? 'anthropic';
  }

  return _config;
}
