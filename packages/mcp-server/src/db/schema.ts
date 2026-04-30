import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const memory = sqliteTable('memory', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  key:       text('key').notNull(),
  value:     text('value').notNull(),
  tags:      text('tags'),
  projectId: text('project_id'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  keyProjectUnique: uniqueIndex('memory_key_project_idx').on(t.key, t.projectId),
}));

export const files = sqliteTable('files', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  path:          text('path').notNull(),
  projectId:     text('project_id'),
  lastWrittenBy: text('last_written_by'),
  createdAt:     text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:     text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const todos = sqliteTable('todos', {
  id:        text('id').primaryKey(),
  title:     text('title').notNull(),
  assignee:  text('assignee'),
  priority:  text('priority', { enum: ['low', 'medium', 'high', 'critical'] }).notNull().default('medium'),
  status:    text('status', { enum: ['todo', 'in-progress', 'done'] }).notNull().default('todo'),
  projectId: text('project_id'),
});

export const projects = sqliteTable('projects', {
  id:      text('id').primaryKey(),
  name:    text('name').notNull(),
  status:  text('status', { enum: ['idle', 'running', 'done', 'error'] }).notNull().default('idle'),
  plan:    text('plan'),
  context: text('context'),
});

export const projectLogs = sqliteTable('project_logs', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  projectId: text('project_id').notNull(),
  message:   text('message').notNull(),
  level:     text('level', { enum: ['info', 'warn', 'error', 'debug'] }).notNull().default('info'),
  agentName: text('agent_name'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const agentQueue = sqliteTable('agent_queue', {
  id:           text('id').primaryKey(),
  agentName:    text('agent_name').notNull(),
  domain:       text('domain').notNull(),
  task:         text('task').notNull(),
  status:       text('status', { enum: ['queued', 'running', 'done', 'error', 'cancelled'] }).notNull().default('queued'),
  dependsOn:    text('depends_on'),
  projectId:    text('project_id'),
  result:       text('result'),
  errorMessage: text('error_message'),
  position:     integer('position'),
  createdAt:    text('created_at').notNull().default(sql`(datetime('now'))`),
  startedAt:    text('started_at'),
  completedAt:  text('completed_at'),
});

export const tokenUsage = sqliteTable('token_usage', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  agentName:     text('agent_name').notNull(),
  projectId:     text('project_id'),
  tokensIn:      integer('tokens_in').notNull(),
  tokensOut:     integer('tokens_out').notNull(),
  totalTokens:   integer('total_tokens').notNull(),
  estimatedCost: real('estimated_cost'),
  model:         text('model'),
  createdAt:     text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const tokenBudget = sqliteTable('token_budget', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  projectId:   text('project_id'),
  limitTokens: integer('limit_tokens').notNull(),
  usedTokens:  integer('used_tokens').notNull().default(0),
  updatedAt:   text('updated_at').notNull().default(sql`(datetime('now'))`),
});
