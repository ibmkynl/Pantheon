import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js → 3 levels up to repo root
const CONFIG_PATH = path.resolve(__dirname, '../../../pantheon.yaml');

const PluginSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  url: z.string().optional(),
});

const ConfigSchema = z.object({
  ai: z.object({
    provider: z.string().default('anthropic'),
    api_key: z.string(),
    base_url: z.string().optional(),
    models: z.object({
      router:     z.string().default('claude-haiku-4-5-20251001'),
      core:       z.string().default('claude-sonnet-4-6'),
      specialist: z.string().default('claude-sonnet-4-6'),
      btw:        z.string().default('claude-haiku-4-5-20251001'),
    }),
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

export type Config   = z.infer<typeof ConfigSchema>;
export type Plugin   = z.infer<typeof PluginSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  _config = ConfigSchema.parse(parse(raw));
  return _config;
}
