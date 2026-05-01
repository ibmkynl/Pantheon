import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Background processes started by this CLI invocation
const children: ChildProcess[] = [];

function pantheonHome(): string {
  return process.env['PANTHEON_HOME'] || path.join(os.homedir(), '.pantheon');
}

/** Locate a sibling package's dist entry inside the installed pantheon-cli tarball. */
function packageEntry(pkg: 'mcp-server' | 'orchestrator'): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, '..', '..', pkg, 'dist', 'index.js');
  return fs.existsSync(candidate) ? candidate : null;
}

async function isUp(url: string, timeoutMs = 600): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), timeoutMs);
    const res  = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string, attempts = 40, intervalMs = 250): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isUp(url)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

interface BootOpts {
  mcpPort?:          number;
  orchestratorPort?: number;
  silent?:           boolean;
}

/**
 * Ensure both MCP server and orchestrator are running.
 * If already up (e.g. user started them manually), reuses them.
 * Otherwise spawns them as child processes that die when the CLI exits.
 */
export async function ensureServers(opts: BootOpts = {}): Promise<{ mcpPort: number; orchPort: number }> {
  const mcpPort  = opts.mcpPort  ?? Number(process.env['MCP_PORT']  ?? 3100);
  const orchPort = opts.orchestratorPort ?? Number(process.env['ORCHESTRATOR_PORT'] ?? 3101);
  const log      = opts.silent ? () => {} : (m: string) => process.stderr.write(`[pantheon] ${m}\n`);

  const home = pantheonHome();
  const env  = {
    ...process.env,
    PANTHEON_HOME: home,
    MCP_PORT:           String(mcpPort),
    MCP_HOST:           process.env['MCP_HOST'] ?? 'localhost',
    ORCHESTRATOR_PORT:  String(orchPort),
    ORCHESTRATOR_HOST:  process.env['ORCHESTRATOR_HOST'] ?? 'localhost',
  };

  const mcpUp  = await isUp(`http://localhost:${mcpPort}/health`);
  if (!mcpUp) {
    const entry = packageEntry('mcp-server');
    if (!entry) throw new Error('Could not locate @pantheon/mcp-server dist. Reinstall pantheon-cli.');
    log(`starting MCP server on :${mcpPort}…`);
    const proc = spawn(process.execPath, [entry], { stdio: 'ignore', detached: false, env });
    proc.unref();
    children.push(proc);
    if (!await waitFor(`http://localhost:${mcpPort}/health`)) {
      throw new Error(`MCP server failed to start on :${mcpPort} within 10s.`);
    }
  }

  const orchUp = await isUp(`http://localhost:${orchPort}/health`);
  if (!orchUp) {
    const entry = packageEntry('orchestrator');
    if (!entry) throw new Error('Could not locate @pantheon/orchestrator dist. Reinstall pantheon-cli.');
    log(`starting orchestrator on :${orchPort}…`);
    const proc = spawn(process.execPath, [entry], { stdio: 'ignore', detached: false, env });
    proc.unref();
    children.push(proc);
    if (!await waitFor(`http://localhost:${orchPort}/health`)) {
      throw new Error(`Orchestrator failed to start on :${orchPort} within 10s.`);
    }
  }

  return { mcpPort, orchPort };
}

/** Tear down child processes started by this CLI invocation. */
export function shutdownServers(): void {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

process.on('exit',    shutdownServers);
process.on('SIGINT',  () => { shutdownServers(); process.exit(130); });
process.on('SIGTERM', () => { shutdownServers(); process.exit(143); });
