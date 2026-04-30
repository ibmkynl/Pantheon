import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

function findConfig(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, 'pantheon.yaml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pantheon.yaml not found (searched up from cwd)');
    dir = parent;
  }
}

const ConfigSchema = z.object({
  mcp: z.object({
    port: z.number().default(3100),
    host: z.string().default('localhost'),
  }),
  orchestrator: z.object({
    port: z.number().default(3101),
    host: z.string().default('localhost'),
  }),
});

let _config: z.infer<typeof ConfigSchema> | null = null;

export function getConfig() {
  if (_config) return _config;
  const raw = fs.readFileSync(findConfig(), 'utf-8');
  _config = ConfigSchema.parse(parse(raw));
  return _config;
}

export function orchestratorUrl(path_: string = '') {
  const { host, port } = getConfig().orchestrator;
  return `http://${host}:${port}${path_}`;
}

export function mcpUrl(path_: string = '') {
  const { host, port } = getConfig().mcp;
  return `http://${host}:${port}${path_}`;
}
