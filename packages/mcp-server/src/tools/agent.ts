import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { eq, isNull } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb, getSqlite } from '../db/index.js';
import { agentQueue } from '../db/schema.js';
import type { SseEmitter } from '../sse.js';

export function registerAgentTools(server: McpServer, sseEmitter: SseEmitter): void {
  server.registerTool(
    'agent.queue_add',
    {
      description: 'Add an agent task to the queue. Returns the new entry id and position.',
      inputSchema: {
        agentName: z.string().min(1),
        domain:    z.string().min(1),
        task:      z.string().min(1),
        dependsOn: z.array(z.string().uuid()).optional(),
        projectId: z.string().optional(),
      },
    },
    async ({ agentName, domain, task, dependsOn, projectId }) => {
      const sqlite = getSqlite();
      const id = uuidv4();
      const dependsOnStr = dependsOn && dependsOn.length > 0 ? dependsOn.join(',') : null;
      const now = new Date().toISOString();

      const insert = sqlite.transaction(() => {
        const posRow = sqlite.prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 as next_pos
          FROM agent_queue WHERE project_id IS ?
        `).get(projectId ?? null) as { next_pos: number };

        sqlite.prepare(`
          INSERT INTO agent_queue
            (id, agent_name, domain, task, status, depends_on, project_id, position, created_at)
          VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
        `).run(id, agentName, domain, task, dependsOnStr, projectId ?? null, posRow.next_pos, now);

        return posRow.next_pos;
      });

      const position = insert();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ id, position }) }] };
    }
  );

  server.registerTool(
    'agent.queue_next',
    {
      description: 'Get the next ready agents from the queue. Applies dependency resolution and domain exclusivity.',
      inputSchema: {
        projectId: z.string().optional(),
      },
    },
    async ({ projectId }) => {
      const sqlite = getSqlite();

      const resolve = sqlite.transaction(() => {
        const queued = sqlite.prepare(`
          SELECT id, agent_name, domain, task, depends_on
          FROM agent_queue
          WHERE status = 'queued'
            AND (? IS NULL OR project_id = ?)
          ORDER BY position ASC
        `).all(projectId ?? null, projectId ?? null) as Array<{
          id: string; agent_name: string; domain: string; task: string; depends_on: string | null;
        }>;

        const runningDomains = sqlite.prepare(`
          SELECT DISTINCT domain FROM agent_queue
          WHERE status = 'running'
            AND (? IS NULL OR project_id = ?)
        `).all(projectId ?? null, projectId ?? null) as Array<{ domain: string }>;
        const runningDomainSet = new Set(runningDomains.map(r => r.domain));

        const doneIds = sqlite.prepare(`
          SELECT id FROM agent_queue WHERE status = 'done'
            AND (? IS NULL OR project_id = ?)
        `).all(projectId ?? null, projectId ?? null) as Array<{ id: string }>;
        const doneIdSet = new Set(doneIds.map(r => r.id));

        const ready: Array<{ id: string; agentName: string; domain: string; task: string }> = [];
        const markRunning = sqlite.prepare(
          `UPDATE agent_queue SET status = 'running', started_at = ? WHERE id = ?`
        );
        const now = new Date().toISOString();

        for (const item of queued) {
          if (item.depends_on) {
            const deps = item.depends_on.split(',').map(s => s.trim()).filter(Boolean);
            if (!deps.every(dep => doneIdSet.has(dep))) continue;
          }
          if (runningDomainSet.has(item.domain)) continue;
          markRunning.run(now, item.id);
          ready.push({ id: item.id, agentName: item.agent_name, domain: item.domain, task: item.task });
          runningDomainSet.add(item.domain);
        }

        return ready;
      });

      const ready = resolve();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ready }) }] };
    }
  );

  server.registerTool(
    'agent.queue_start',
    {
      description: 'Mark a queued agent task as running.',
      inputSchema: {
        id: z.string().uuid(),
      },
    },
    async ({ id }) => {
      const db = getDb();
      await db.update(agentQueue).set({ status: 'running', startedAt: new Date().toISOString() }).where(eq(agentQueue.id, id));
      return { content: [{ type: 'text' as const, text: `Started agent task ${id}` }] };
    }
  );

  server.registerTool(
    'agent.queue_complete',
    {
      description: 'Mark an agent task as done and store its result.',
      inputSchema: {
        id:     z.string().uuid(),
        result: z.string(),
      },
    },
    async ({ id, result }) => {
      const db = getDb();
      await db.update(agentQueue).set({ status: 'done', result, completedAt: new Date().toISOString() }).where(eq(agentQueue.id, id));
      return { content: [{ type: 'text' as const, text: `Completed agent task ${id}` }] };
    }
  );

  server.registerTool(
    'agent.queue_error',
    {
      description: 'Mark an agent task as errored.',
      inputSchema: {
        id:           z.string().uuid(),
        errorMessage: z.string(),
      },
    },
    async ({ id, errorMessage }) => {
      const db = getDb();
      await db.update(agentQueue).set({ status: 'error', errorMessage, completedAt: new Date().toISOString() }).where(eq(agentQueue.id, id));
      return { content: [{ type: 'text' as const, text: `Errored agent task ${id}` }] };
    }
  );

  server.registerTool(
    'agent.queue_status',
    {
      description: 'Get a full snapshot of the agent queue for a project.',
      inputSchema: {
        projectId: z.string().optional(),
      },
    },
    async ({ projectId }) => {
      const db = getDb();
      const condition = projectId != null ? eq(agentQueue.projectId, projectId) : isNull(agentQueue.projectId);
      const rows = await db.select().from(agentQueue).where(condition);
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] };
    }
  );

  server.registerTool(
    'agent.queue_reorder',
    {
      description: 'Reorder queued agent entries by updating their position values. Only affects entries with status=queued.',
      inputSchema: {
        projectId: z.string().optional(),
        order:     z.array(z.object({ id: z.string().uuid(), position: z.number().int().min(1) })),
      },
    },
    async ({ projectId, order }) => {
      const sqlite = getSqlite();
      sqlite.transaction(() => {
        const update = sqlite.prepare(`
          UPDATE agent_queue SET position = ?
          WHERE id = ? AND status = 'queued'
            AND (? IS NULL OR project_id = ?)
        `);
        for (const { id, position } of order) {
          update.run(position, id, projectId ?? null, projectId ?? null);
        }
      })();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ reordered: order.length }) }] };
    }
  );

  server.registerTool(
    'agent.emit_event',
    {
      description: 'Push a live event to all SSE subscribers on GET /events.',
      inputSchema: {
        agentName: z.string().min(1),
        type:      z.string().min(1),
        message:   z.string(),
        data:      z.record(z.unknown()).optional(),
      },
    },
    async ({ agentName, type, message, data }) => {
      sseEmitter.emit({ agentName, type, message, data: data ?? null, timestamp: new Date().toISOString() });
      return { content: [{ type: 'text' as const, text: `Event emitted: ${type}` }] };
    }
  );
}
