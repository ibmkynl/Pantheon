import { z } from 'zod';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSqlite } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveWorkspaceBase(): string {
  const env = process.env['PANTHEON_WORKSPACES'];
  if (env) return path.resolve(env);
  const cwdLocal = path.resolve(process.cwd(), 'workspaces');
  if (process.env['PANTHEON_HOME'] === undefined) {
    return path.resolve(__dirname, '../../../workspaces');
  }
  void cwdLocal;
  const home = process.env['PANTHEON_HOME'] || path.join(os.homedir(), '.pantheon');
  return path.join(home, 'workspaces');
}

const WORKSPACE_BASE = resolveWorkspaceBase();

function sandboxPath(filePath: string, projectId?: string): string {
  const projectDir = path.join(WORKSPACE_BASE, projectId ?? '_global', 'files');
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    throw new Error(`Path traversal detected: "${filePath}"`);
  }
  return resolved;
}

export function registerFileTools(server: McpServer): void {
  server.registerTool('file.write', {
    description: 'Write content to a file in the project workspace sandbox.',
    inputSchema: { path: z.string().min(1), content: z.string(), agentName: z.string().min(1), projectId: z.string().optional() },
  }, async ({ path: filePath, content, agentName, projectId }) => {
    const fullPath = sandboxPath(filePath, projectId);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    const now = new Date().toISOString();
    getSqlite().prepare(`INSERT INTO files (path, project_id, last_written_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, project_id) DO UPDATE SET last_written_by = excluded.last_written_by, updated_at = excluded.updated_at`).run(filePath, projectId ?? null, agentName, now, now);
    return { content: [{ type: 'text' as const, text: `Written ${filePath}` }] };
  });

  server.registerTool('file.read', {
    description: 'Read a file from the project workspace sandbox.',
    inputSchema: { path: z.string().min(1), projectId: z.string().optional() },
  }, async ({ path: filePath, projectId }) => {
    const fullPath = sandboxPath(filePath, projectId);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      return { content: [{ type: 'text' as const, text: content }] };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return { content: [{ type: 'text' as const, text: `File not found: ${filePath}` }], isError: true };
      throw err;
    }
  });

  server.registerTool('file.list', {
    description: 'List files in a directory within the project workspace sandbox.',
    inputSchema: { dir: z.string().optional().default('.'), projectId: z.string().optional() },
  }, async ({ dir, projectId }) => {
    const fullPath = sandboxPath(dir ?? '.', projectId);
    try {
      await fs.mkdir(fullPath, { recursive: true });
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const result = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch {
      return { content: [{ type: 'text' as const, text: '[]' }] };
    }
  });

  server.registerTool('file.delete', {
    description: 'Delete a file from the project workspace sandbox.',
    inputSchema: { path: z.string().min(1), projectId: z.string().optional() },
  }, async ({ path: filePath, projectId }) => {
    const fullPath = sandboxPath(filePath, projectId);
    getSqlite().prepare(`DELETE FROM files WHERE path = ? AND project_id IS ?`).run(filePath, projectId ?? null);
    await fs.unlink(fullPath);
    return { content: [{ type: 'text' as const, text: `Deleted ${filePath}` }] };
  });

  server.registerTool('file.exists', {
    description: 'Check whether a file exists in the project workspace sandbox.',
    inputSchema: { path: z.string().min(1), projectId: z.string().optional() },
  }, async ({ path: filePath, projectId }) => {
    const fullPath = sandboxPath(filePath, projectId);
    try {
      await fs.access(fullPath);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ exists: true, path: filePath }) }] };
    } catch {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ exists: false, path: filePath }) }] };
    }
  });
}
