import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { eq, isNull } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb, getSqlite } from '../db/index.js';
import { agentQueue } from '../db/schema.js';
import type { SseEmitter } from '../sse.js';

// Agents directory: $PANTHEON_AGENTS_DIR or <package-root>/agents
const AGENTS_DIR = process.env['PANTHEON_AGENTS_DIR']
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../agents');

export function registerAgentTools(server: McpServer, sseEmitter: SseEmitter): void {
  server.registerTool('agent.queue_add', {
    description: 'Add an agent task to the queue. Returns the new entry id and position.',
    inputSchema: {
      agentName: z.string().min(1),
      domain:    z.string().min(1),
      task:      z.string().min(1),
      dependsOn: z.array(z.string().uuid()).optional(),
      projectId: z.string().optional(),
    },
  }, async ({ agentName, domain, task, dependsOn, projectId }) => {
    const sqlite = getSqlite();
    const id = uuidv4();
    const dependsOnStr = dependsOn && dependsOn.length > 0 ? dependsOn.join(',') : null;
    const now = new Date().toISOString();
    const insert = sqlite.transaction(() => {
      const posRow = sqlite.prepare(`SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM agent_queue WHERE project_id IS ?`).get(projectId ?? null) as { next_pos: number };
      sqlite.prepare(`INSERT INTO agent_queue (id, agent_name, domain, task, status, depends_on, project_id, position, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, agentName, domain, task, dependsOnStr, projectId ?? null, posRow.next_pos, now);
      return posRow.next_pos;
    });
    const position = insert();
    return { content: [{ type: 'text' as const, text: JSON.stringify({ id, position }) }] };
  });

  server.registerTool('agent.queue_next', {
    description: 'Get the next ready agents from the queue. Applies dependency resolution and domain exclusivity.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    const sqlite = getSqlite();
    const resolve = sqlite.transaction(() => {
      const queued = sqlite.prepare(`SELECT id, agent_name, domain, task, depends_on FROM agent_queue WHERE status = 'queued' AND (? IS NULL OR project_id = ?) ORDER BY position ASC`).all(projectId ?? null, projectId ?? null) as Array<{ id: string; agent_name: string; domain: string; task: string; depends_on: string | null }>;
      const runningDomains = sqlite.prepare(`SELECT DISTINCT domain FROM agent_queue WHERE status = 'running' AND (? IS NULL OR project_id = ?)`).all(projectId ?? null, projectId ?? null) as Array<{ domain: string }>;
      const runningDomainSet = new Set(runningDomains.map(r => r.domain));
      const doneIds = sqlite.prepare(`SELECT id FROM agent_queue WHERE status = 'done' AND (? IS NULL OR project_id = ?)`).all(projectId ?? null, projectId ?? null) as Array<{ id: string }>;
      const doneIdSet = new Set(doneIds.map(r => r.id));
      const ready: Array<{ id: string; agentName: string; domain: string; task: string }> = [];
      const markRunning = sqlite.prepare(`UPDATE agent_queue SET status = 'running', started_at = ? WHERE id = ?`);
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
  });

  server.registerTool('agent.queue_start', {
    description: 'Mark a queued agent task as running.',
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }) => {
    const db = getDb();
    await db.update(agentQueue).set({ status: 'running', startedAt: new Date().toISOString() }).where(eq(agentQueue.id, id));
    return { content: [{ type: 'text' as const, text: `Started agent task ${id}` }] };
  });

  server.registerTool('agent.queue_complete', {
    description: 'Mark an agent task as done and store its result.',
    inputSchema: { id: z.string().uuid(), result: z.string() },
  }, async ({ id, result }) => {
    const db = getDb();
    await db.update(agentQueue).set({ status: 'done', result, completedAt: new Date().toISOString() }).where(eq(agentQueue.id, id));
    return { content: [{ type: 'text' as const, text: `Completed agent task ${id}` }] };
  });

  server.registerTool('agent.queue_error', {
    description: 'Mark an agent task as errored.',
    inputSchema: { id: z.string().uuid(), errorMessage: z.string() },
  }, async ({ id, errorMessage }) => {
    const db = getDb();
    await db.update(agentQueue).set({ status: 'error', errorMessage, completedAt: new Date().toISOString() }).where(eq(agentQueue.id, id));
    return { content: [{ type: 'text' as const, text: `Errored agent task ${id}` }] };
  });

  server.registerTool('agent.queue_status', {
    description: 'Get a full snapshot of the agent queue for a project.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    const db = getDb();
    const condition = projectId != null ? eq(agentQueue.projectId, projectId) : isNull(agentQueue.projectId);
    const rows = await db.select().from(agentQueue).where(condition);
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] };
  });

  server.registerTool('agent.queue_reorder', {
    description: 'Reorder queued agent entries by updating their position values. Only affects entries with status=queued.',
    inputSchema: {
      projectId: z.string().optional(),
      order:     z.array(z.object({ id: z.string().uuid(), position: z.number().int().min(1) })),
    },
  }, async ({ projectId, order }) => {
    const sqlite = getSqlite();
    sqlite.transaction(() => {
      const update = sqlite.prepare(`UPDATE agent_queue SET position = ? WHERE id = ? AND status = 'queued' AND (? IS NULL OR project_id = ?)`);
      for (const { id, position } of order) {
        update.run(position, id, projectId ?? null, projectId ?? null);
      }
    })();
    return { content: [{ type: 'text' as const, text: JSON.stringify({ reordered: order.length }) }] };
  });

  server.registerTool('agent.create_agent', {
    description: 'Create a new agent by writing its system prompt .md file to the agents/ directory. Used by Prometheus.',
    inputSchema: {
      name:    z.string().min(1).regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric + hyphens'),
      tier:    z.enum(['router-tier', 'core-tier', 'specialist-tier']),
      content: z.string().min(10),
    },
  }, async ({ name, tier, content }) => {
    const dir  = path.join(AGENTS_DIR, tier);
    const file = path.join(dir, `${name}.md`);
    if (!file.startsWith(AGENTS_DIR)) throw new Error('Invalid agent name — path traversal detected');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
    return { content: [{ type: 'text' as const, text: JSON.stringify({ created: `${tier}/${name}.md`, path: file }) }] };
  });

  // ---- agent.report_status -------------------------------------------------
  server.registerTool('agent.report_status', {
    description: 'Report progress from a running agent. Persists a status message on the queue entry and emits it over SSE so the CLI shows it live.',
    inputSchema: {
      queueId: z.string().uuid().describe('The agent_queue id of this running agent'),
      message: z.string().min(1).describe('Human-readable progress message, e.g. "Analysing file 3/10"'),
      data:    z.record(z.unknown()).optional().describe('Optional structured payload attached to the SSE event'),
    },
  }, async ({ queueId, message, data }) => {
    const sqlite = getSqlite();
    sqlite.prepare(`UPDATE agent_queue SET status_message = ? WHERE id = ?`).run(message, queueId);

    // Also get agent name so the SSE event is attributed correctly
    const row = sqlite.prepare(`SELECT agent_name, project_id FROM agent_queue WHERE id = ?`).get(queueId) as { agent_name: string; project_id: string | null } | undefined;
    if (row) {
      sseEmitter.emit({
        agentName: row.agent_name,
        type: 'agent.status',
        message,
        data: { queueId, projectId: row.project_id, ...(data ?? {}) },
        timestamp: new Date().toISOString(),
      });
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ updated: true, queueId, message }) }] };
  });

  // ---- agent.send_message --------------------------------------------------
  server.registerTool('agent.send_message', {
    description: 'Send a control message from the orchestrator to a running agent. The agent polls with agent.get_messages. type: "message" | "cancel" | "update_task".',
    inputSchema: {
      agentName: z.string().min(1),
      type:      z.enum(['message', 'cancel', 'update_task']).default('message'),
      payload:   z.string().optional().describe('JSON-serialisable string payload'),
      queueId:   z.string().uuid().optional().describe('Target specific queue entry; omit to message all agents with this name'),
      projectId: z.string().optional(),
    },
  }, async ({ agentName, type, payload, queueId, projectId }) => {
    const sqlite = getSqlite();
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO agent_inbox (queue_id, agent_name, project_id, type, payload, read, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(queueId ?? null, agentName, projectId ?? null, type, payload ?? null, now);

    // If it's a cancel, also update the queue entry status directly
    if (type === 'cancel') {
      if (queueId) {
        sqlite.prepare(`UPDATE agent_queue SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('queued','running')`).run(now, queueId);
      } else {
        sqlite.prepare(`UPDATE agent_queue SET status = 'cancelled', completed_at = ? WHERE agent_name = ? AND (? IS NULL OR project_id = ?) AND status IN ('queued','running')`).run(now, agentName, projectId ?? null, projectId ?? null);
      }
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ sent: true, type, agentName, queueId: queueId ?? null }) }] };
  });

  // ---- agent.get_messages --------------------------------------------------
  server.registerTool('agent.get_messages', {
    description: 'Poll the inbox for messages addressed to this agent. Marks messages as read. Call at the start of each tool loop iteration.',
    inputSchema: {
      agentName: z.string().min(1),
      queueId:   z.string().uuid().optional(),
      projectId: z.string().optional(),
      markRead:  z.boolean().optional().default(true),
    },
  }, async ({ agentName, queueId, projectId, markRead = true }) => {
    const sqlite = getSqlite();

    const rows = sqlite.prepare(`
      SELECT id, type, payload, created_at FROM agent_inbox
      WHERE agent_name = ?
        AND read = 0
        AND (? IS NULL OR queue_id = ?)
        AND (? IS NULL OR project_id = ?)
      ORDER BY created_at ASC
    `).all(agentName, queueId ?? null, queueId ?? null, projectId ?? null, projectId ?? null) as Array<{ id: number; type: string; payload: string | null; created_at: string }>;

    if (markRead && rows.length > 0) {
      const ids = rows.map(r => r.id);
      sqlite.prepare(`UPDATE agent_inbox SET read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(rows.map(r => ({ type: r.type, payload: r.payload, at: r.created_at }))) }] };
  });

  // ---- agent.cancel --------------------------------------------------------
  server.registerTool('agent.cancel', {
    description: 'Cancel one or all queued/running agents for a project. Sends a cancel inbox message and marks queue entries as cancelled.',
    inputSchema: {
      projectId: z.string().optional(),
      queueId:   z.string().uuid().optional().describe('Cancel a specific queue entry. If omitted, cancels all non-terminal entries for the project.'),
    },
  }, async ({ projectId, queueId }) => {
    const sqlite = getSqlite();
    const now = new Date().toISOString();
    let changes = 0;

    if (queueId) {
      const r = sqlite.prepare(`UPDATE agent_queue SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('queued','running')`).run(now, queueId);
      changes = r.changes;
      const row = sqlite.prepare(`SELECT agent_name FROM agent_queue WHERE id = ?`).get(queueId) as { agent_name: string } | undefined;
      if (row) {
        sqlite.prepare(`INSERT INTO agent_inbox (queue_id, agent_name, project_id, type, read, created_at) VALUES (?, ?, ?, 'cancel', 0, ?)`).run(queueId, row.agent_name, projectId ?? null, now);
      }
    } else {
      const rows = sqlite.prepare(`SELECT id, agent_name FROM agent_queue WHERE (? IS NULL OR project_id = ?) AND status IN ('queued','running')`).all(projectId ?? null, projectId ?? null) as Array<{ id: string; agent_name: string }>;
      const update = sqlite.prepare(`UPDATE agent_queue SET status = 'cancelled', completed_at = ? WHERE id = ?`);
      const inbox  = sqlite.prepare(`INSERT INTO agent_inbox (queue_id, agent_name, project_id, type, read, created_at) VALUES (?, ?, ?, 'cancel', 0, ?)`);
      const tx = sqlite.transaction(() => {
        for (const row of rows) {
          update.run(now, row.id);
          inbox.run(row.id, row.agent_name, projectId ?? null, now);
        }
      });
      tx();
      changes = rows.length;
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ cancelled: changes }) }] };
  });

  server.registerTool('agent.emit_event', {
    description: 'Push a live event to all SSE subscribers on GET /events.',
    inputSchema: {
      agentName: z.string().min(1),
      type:      z.string().min(1),
      message:   z.string(),
      data:      z.record(z.unknown()).optional(),
    },
  }, async ({ agentName, type, message, data }) => {
    sseEmitter.emit({ agentName, type, message, data: data ?? null, timestamp: new Date().toISOString() });
    return { content: [{ type: 'text' as const, text: `Event emitted: ${type}` }] };
  });
}
