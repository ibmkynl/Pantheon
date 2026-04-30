import { z } from 'zod';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb, getSqlite } from '../db/index.js';
import { memory } from '../db/schema.js';

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    'memory.save',
    {
      description: 'Upsert a key-value pair into memory. Overwrites existing entry if key+projectId match.',
      inputSchema: {
        key:       z.string().min(1),
        value:     z.string(),
        tags:      z.string().optional().describe('Comma-separated tags'),
        projectId: z.string().optional(),
      },
    },
    async ({ key, value, tags, projectId }) => {
      const now = new Date().toISOString();
      getSqlite().prepare(`
        INSERT INTO memory (key, value, tags, project_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key, project_id) DO UPDATE SET
          value      = excluded.value,
          tags       = excluded.tags,
          updated_at = excluded.updated_at
      `).run(key, value, tags ?? null, projectId ?? null, now, now);
      return { content: [{ type: 'text' as const, text: `Saved memory key "${key}"` }] };
    }
  );

  server.registerTool(
    'memory.search',
    {
      description: 'Full-text search memory entries using FTS5.',
      inputSchema: {
        query:     z.string().min(1),
        limit:     z.number().int().min(1).max(100).optional().default(10),
        projectId: z.string().optional(),
      },
    },
    async ({ query, limit, projectId }) => {
      const sqlite = getSqlite();
      // When projectId is provided, filter to that project only; otherwise return all
      const rows = sqlite.prepare(`
        SELECT m.id, m.key, m.value, m.tags, m.project_id
        FROM memory_fts
        JOIN memory m ON memory_fts.rowid = m.id
        WHERE memory_fts MATCH ?
          AND (? IS NULL OR m.project_id = ?)
        ORDER BY rank
        LIMIT ?
      `).all(query, projectId ?? null, projectId ?? null, limit) as Array<{
        id: number; key: string; value: string; tags: string | null; project_id: string | null;
      }>;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(rows.map(r => ({ key: r.key, value: r.value, tags: r.tags, projectId: r.project_id }))),
        }],
      };
    }
  );

  server.registerTool(
    'memory.get',
    {
      description: 'Get a memory entry by exact key.',
      inputSchema: {
        key:       z.string().min(1),
        projectId: z.string().optional(),
      },
    },
    async ({ key, projectId }) => {
      const db = getDb();
      const condition = projectId != null
        ? and(eq(memory.key, key), eq(memory.projectId, projectId))
        : and(eq(memory.key, key), isNull(memory.projectId));
      const row = await db.select().from(memory).where(condition).get();
      return {
        content: [{
          type: 'text' as const,
          text: row ? JSON.stringify({ key: row.key, value: row.value, tags: row.tags }) : 'null',
        }],
      };
    }
  );

  server.registerTool(
    'memory.list',
    {
      description: 'List all memory keys, optionally filtered by tag.',
      inputSchema: {
        tag:       z.string().optional(),
        projectId: z.string().optional(),
      },
    },
    async ({ tag, projectId }) => {
      const db = getDb();
      const conditions = [];
      if (tag) {
        const escaped = tag.replace(/[%_\\]/g, '\\$&');
        conditions.push(sql`${memory.tags} LIKE ${'%' + escaped + '%'} ESCAPE '\\'`);
      }
      if (projectId != null) conditions.push(eq(memory.projectId, projectId));
      else conditions.push(isNull(memory.projectId));

      const rows = conditions.length > 0
        ? await db.select({ key: memory.key, tags: memory.tags }).from(memory).where(and(...conditions))
        : await db.select({ key: memory.key, tags: memory.tags }).from(memory);
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] };
    }
  );

  server.registerTool(
    'memory.delete',
    {
      description: 'Delete a memory entry by key.',
      inputSchema: {
        key:       z.string().min(1),
        projectId: z.string().optional(),
      },
    },
    async ({ key, projectId }) => {
      const db = getDb();
      const condition = projectId != null
        ? and(eq(memory.key, key), eq(memory.projectId, projectId))
        : and(eq(memory.key, key), isNull(memory.projectId));
      await db.delete(memory).where(condition);
      return { content: [{ type: 'text' as const, text: `Deleted memory key "${key}"` }] };
    }
  );
}
