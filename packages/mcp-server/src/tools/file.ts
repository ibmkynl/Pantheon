import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, and, isNull } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db/index.js';
import { files } from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// workspaces/ lives at repo root — tsup bundles everything to dist/index.js,
// so __dirname = .../packages/mcp-server/dist → 3 levels up to repo root
const WORKSPACE_BASE = path.resolve(__dirname, '../../../workspaces');

function sandboxPath(filePath: string, projectId?: string): string {
  const projectDir = path.join(WORKSPACE_BASE, projectId ?? '_global', 'files');
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    throw new Error(`Path traversal detected: "${filePath}"`);
  }
  return resolved;
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    'file.write',
    {
      description: 'Write content to a file in the project workspace sandbox.',
      inputSchema: {
        path:      z.string().min(1),
        content:   z.string(),
        agentName: z.string().min(1),
        projectId: z.string().optional(),
      },
    },
    async ({ path: filePath, content, agentName, projectId }) => {
      const fullPath = sandboxPath(filePath, projectId);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');

      const db = getDb();
      const now = new Date().toISOString();
      const condition = projectId != null
        ? and(eq(files.path, filePath), eq(files.projectId, projectId))
        : and(eq(files.path, filePath), isNull(files.projectId));
      const existing = await db.select().from(files).where(condition).get();

      if (existing) {
        await db.update(files).set({ lastWrittenBy: agentName, updatedAt: now }).where(eq(files.id, existing.id));
      } else {
        await db.insert(files).values({ path: filePath, projectId: projectId ?? null, lastWrittenBy: agentName, createdAt: now, updatedAt: now });
      }
      return { content: [{ type: 'text' as const, text: `Written ${filePath}` }] };
    }
  );

  server.registerTool(
    'file.read',
    {
      description: 'Read a file from the project workspace sandbox.',
      inputSchema: {
        path:      z.string().min(1),
        projectId: z.string().optional(),
      },
    },
    async ({ path: filePath, projectId }) => {
      const fullPath = sandboxPath(filePath, projectId);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        return { content: [{ type: 'text' as const, text: content }] };
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
          return { content: [{ type: 'text' as const, text: `File not found: ${filePath}` }], isError: true };
        }
        throw err;
      }
    }
  );

  server.registerTool(
    'file.list',
    {
      description: 'List files in a directory within the project workspace sandbox.',
      inputSchema: {
        dir:       z.string().optional().default('.'),
        projectId: z.string().optional(),
      },
    },
    async ({ dir, projectId }) => {
      const fullPath = sandboxPath(dir ?? '.', projectId);
      try {
        await fs.mkdir(fullPath, { recursive: true });
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const result = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch {
        return { content: [{ type: 'text' as const, text: '[]' }] };
      }
    }
  );

  server.registerTool(
    'file.delete',
    {
      description: 'Delete a file from the project workspace sandbox.',
      inputSchema: {
        path:      z.string().min(1),
        projectId: z.string().optional(),
      },
    },
    async ({ path: filePath, projectId }) => {
      const fullPath = sandboxPath(filePath, projectId);
      await fs.unlink(fullPath);
      const db = getDb();
      const condition = projectId != null
        ? and(eq(files.path, filePath), eq(files.projectId, projectId))
        : and(eq(files.path, filePath), isNull(files.projectId));
      await db.delete(files).where(condition);
      return { content: [{ type: 'text' as const, text: `Deleted ${filePath}` }] };
    }
  );

  server.registerTool(
    'file.exists',
    {
      description: 'Check whether a file exists in the project workspace sandbox.',
      inputSchema: {
        path:      z.string().min(1),
        projectId: z.string().optional(),
      },
    },
    async ({ path: filePath, projectId }) => {
      const fullPath = sandboxPath(filePath, projectId);
      try {
        await fs.access(fullPath);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ exists: true, path: filePath }) }] };
      } catch {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ exists: false, path: filePath }) }] };
      }
    }
  );
}
