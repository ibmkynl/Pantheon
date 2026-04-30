import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, isNull } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db/index.js';
import { todos } from '../db/schema.js';

export function registerTodoTools(server: McpServer): void {
  server.registerTool(
    'todo.add',
    {
      description: 'Create a new todo task.',
      inputSchema: {
        title:     z.string().min(1),
        assignee:  z.string().optional(),
        priority:  z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
        projectId: z.string().optional(),
      },
    },
    async ({ title, assignee, priority, projectId }) => {
      const db = getDb();
      const id = uuidv4();
      await db.insert(todos).values({ id, title, assignee: assignee ?? null, priority, status: 'todo', projectId: projectId ?? null });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ id, title, priority, status: 'todo' }) }] };
    }
  );

  server.registerTool(
    'todo.list',
    {
      description: 'List todos, optionally filtered by status, assignee, and project.',
      inputSchema: {
        status:    z.enum(['todo', 'in-progress', 'done']).optional(),
        assignee:  z.string().optional(),
        projectId: z.string().optional(),
      },
    },
    async ({ status, assignee, projectId }) => {
      const db = getDb();
      const conditions = [];
      if (status)   conditions.push(eq(todos.status, status));
      if (assignee) conditions.push(eq(todos.assignee, assignee));
      if (projectId != null) conditions.push(eq(todos.projectId, projectId));
      else conditions.push(isNull(todos.projectId));

      const rows = conditions.length > 0
        ? await db.select().from(todos).where(and(...conditions))
        : await db.select().from(todos);
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] };
    }
  );

  server.registerTool(
    'todo.update',
    {
      description: 'Update fields on a todo item.',
      inputSchema: {
        id:     z.string().uuid(),
        fields: z.object({
          title:    z.string().optional(),
          assignee: z.string().optional(),
          priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          status:   z.enum(['todo', 'in-progress', 'done']).optional(),
        }),
        projectId: z.string().optional(),
      },
    },
    async ({ id, fields, projectId }) => {
      const db = getDb();
      const condition = projectId != null
        ? and(eq(todos.id, id), eq(todos.projectId, projectId))
        : and(eq(todos.id, id), isNull(todos.projectId));
      await db.update(todos).set(fields).where(condition);
      return { content: [{ type: 'text' as const, text: `Updated todo ${id}` }] };
    }
  );

  server.registerTool(
    'todo.complete',
    {
      description: 'Mark a todo as done.',
      inputSchema: {
        id:        z.string().uuid(),
        projectId: z.string().optional(),
      },
    },
    async ({ id }) => {
      const db = getDb();
      await db.update(todos).set({ status: 'done' }).where(eq(todos.id, id));
      return { content: [{ type: 'text' as const, text: `Completed todo ${id}` }] };
    }
  );

  server.registerTool(
    'todo.delete',
    {
      description: 'Delete a todo item.',
      inputSchema: {
        id:        z.string().uuid(),
        projectId: z.string().optional(),
      },
    },
    async ({ id }) => {
      const db = getDb();
      await db.delete(todos).where(eq(todos.id, id));
      return { content: [{ type: 'text' as const, text: `Deleted todo ${id}` }] };
    }
  );
}
