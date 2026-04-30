import { z } from 'zod';
import { eq, and, isNull, desc } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db/index.js';
import { projects, projectLogs, tokenUsage, tokenBudget } from '../db/schema.js';

const COST_PER_M_TOKENS: Record<string, number> = {
  'claude-haiku-4-5-20251001': 0.80,
  'claude-sonnet-4-6': 3.00,
};

function estimateCost(model: string | undefined, totalTokens: number): number {
  const rate = model ? (COST_PER_M_TOKENS[model] ?? 3.00) : 3.00;
  return (totalTokens / 1_000_000) * rate;
}

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    'project.get_context',
    {
      description: 'Get the current project row (name, status, context JSON).',
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) => {
      if (!projectId) return { content: [{ type: 'text' as const, text: 'null' }] };
      const db = getDb();
      const row = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      return { content: [{ type: 'text' as const, text: JSON.stringify(row ?? null) }] };
    }
  );

  server.registerTool(
    'project.update',
    {
      description: 'Update project name, status, or context. Creates the project if it does not exist.',
      inputSchema: {
        fields: z.object({
          name:    z.string().optional(),
          status:  z.enum(['idle', 'running', 'done', 'error']).optional(),
          context: z.string().optional().describe('JSON string'),
        }),
        projectId: z.string(),
      },
    },
    async ({ fields, projectId }) => {
      const db = getDb();
      const existing = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!existing) {
        await db.insert(projects).values({ id: projectId, name: fields.name ?? projectId, status: fields.status ?? 'idle', plan: null, context: fields.context ?? null });
      } else {
        await db.update(projects).set(fields).where(eq(projects.id, projectId));
      }
      return { content: [{ type: 'text' as const, text: `Updated project ${projectId}` }] };
    }
  );

  server.registerTool(
    'project.set_plan',
    {
      description: 'Store the project plan text.',
      inputSchema: {
        plan:      z.string(),
        projectId: z.string(),
      },
    },
    async ({ plan, projectId }) => {
      const db = getDb();
      const existing = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!existing) {
        await db.insert(projects).values({ id: projectId, name: projectId, status: 'idle', plan, context: null });
      } else {
        await db.update(projects).set({ plan }).where(eq(projects.id, projectId));
      }
      return { content: [{ type: 'text' as const, text: `Plan set for project ${projectId}` }] };
    }
  );

  server.registerTool(
    'project.get_plan',
    {
      description: 'Retrieve the project plan text.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      const db = getDb();
      const row = await db.select({ plan: projects.plan }).from(projects).where(eq(projects.id, projectId)).get();
      return { content: [{ type: 'text' as const, text: row?.plan ?? '' }] };
    }
  );

  server.registerTool(
    'project.log',
    {
      description: 'Append a log entry to the project log.',
      inputSchema: {
        message:   z.string().min(1),
        level:     z.enum(['info', 'warn', 'error', 'debug']).optional().default('info'),
        agentName: z.string().optional(),
        projectId: z.string().optional(),
      },
    },
    async ({ message, level, agentName, projectId }) => {
      const db = getDb();
      await db.insert(projectLogs).values({
        projectId: projectId ?? '_global',
        message,
        level,
        agentName: agentName ?? null,
        createdAt: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: 'Logged' }] };
    }
  );

  server.registerTool(
    'project.get_logs',
    {
      description: 'Get recent project log entries.',
      inputSchema: {
        limit:     z.number().int().min(1).max(500).optional().default(50),
        projectId: z.string().optional(),
      },
    },
    async ({ limit, projectId }) => {
      const db = getDb();
      const rows = projectId
        ? await db.select().from(projectLogs).where(eq(projectLogs.projectId, projectId)).orderBy(desc(projectLogs.createdAt)).limit(limit)
        : await db.select().from(projectLogs).orderBy(desc(projectLogs.createdAt)).limit(limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] };
    }
  );

  server.registerTool(
    'token.check_budget',
    {
      description: 'Check if there is budget remaining for token usage.',
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) => {
      const db = getDb();
      const condition = projectId != null ? eq(tokenBudget.projectId, projectId) : isNull(tokenBudget.projectId);
      const budget = await db.select().from(tokenBudget).where(condition).get();
      if (!budget) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ allowed: true, remaining: null, used: 0, limit: null, percentUsed: 0 }) }] };
      }
      const remaining = budget.limitTokens - budget.usedTokens;
      const percentUsed = Math.round((budget.usedTokens / budget.limitTokens) * 100);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ allowed: remaining > 0, remaining, used: budget.usedTokens, limit: budget.limitTokens, percentUsed }) }] };
    }
  );

  server.registerTool(
    'token.consume',
    {
      description: 'Record token usage and update the budget.',
      inputSchema: {
        agentName: z.string().min(1),
        tokensIn:  z.number().int().min(0),
        tokensOut: z.number().int().min(0),
        model:     z.string().optional(),
        projectId: z.string().optional(),
      },
    },
    async ({ agentName, tokensIn, tokensOut, model, projectId }) => {
      const db = getDb();
      const totalTokens = tokensIn + tokensOut;
      const cost = estimateCost(model, totalTokens);

      await db.insert(tokenUsage).values({
        agentName,
        projectId: projectId ?? null,
        tokensIn,
        tokensOut,
        totalTokens,
        estimatedCost: cost,
        model: model ?? null,
        createdAt: new Date().toISOString(),
      });

      const condition = projectId != null ? eq(tokenBudget.projectId, projectId) : isNull(tokenBudget.projectId);
      const budget = await db.select().from(tokenBudget).where(condition).get();
      if (budget) {
        await db.update(tokenBudget)
          .set({ usedTokens: budget.usedTokens + totalTokens, updatedAt: new Date().toISOString() })
          .where(eq(tokenBudget.id, budget.id));
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ totalTokens, estimatedCost: cost }) }] };
    }
  );

  server.registerTool(
    'token.get_usage',
    {
      description: 'Get token usage report, optionally filtered by agent and project.',
      inputSchema: {
        agentName: z.string().optional(),
        projectId: z.string().optional(),
      },
    },
    async ({ agentName, projectId }) => {
      const db = getDb();
      const conditions = [];
      if (agentName) conditions.push(eq(tokenUsage.agentName, agentName));
      if (projectId != null) conditions.push(eq(tokenUsage.projectId, projectId));

      const rows = conditions.length > 0
        ? await db.select().from(tokenUsage).where(and(...conditions))
        : await db.select().from(tokenUsage);

      const totals = rows.reduce((acc, r) => ({
        tokensIn:      acc.tokensIn + r.tokensIn,
        tokensOut:     acc.tokensOut + r.tokensOut,
        totalTokens:   acc.totalTokens + r.totalTokens,
        estimatedCost: acc.estimatedCost + (r.estimatedCost ?? 0),
      }), { tokensIn: 0, tokensOut: 0, totalTokens: 0, estimatedCost: 0 });

      return { content: [{ type: 'text' as const, text: JSON.stringify({ rows, totals }) }] };
    }
  );

  server.registerTool(
    'token.set_limit',
    {
      description: 'Set or update the token budget cap for a project.',
      inputSchema: {
        limitTokens: z.number().int().min(1),
        projectId:   z.string().optional(),
      },
    },
    async ({ limitTokens, projectId }) => {
      const db = getDb();
      const condition = projectId != null ? eq(tokenBudget.projectId, projectId) : isNull(tokenBudget.projectId);
      const existing = await db.select().from(tokenBudget).where(condition).get();
      const now = new Date().toISOString();
      if (existing) {
        await db.update(tokenBudget).set({ limitTokens, updatedAt: now }).where(eq(tokenBudget.id, existing.id));
      } else {
        await db.insert(tokenBudget).values({ projectId: projectId ?? null, limitTokens, usedTokens: 0, updatedAt: now });
      }
      return { content: [{ type: 'text' as const, text: `Budget set to ${limitTokens} tokens` }] };
    }
  );
}
