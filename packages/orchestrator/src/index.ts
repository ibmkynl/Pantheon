import Fastify from 'fastify';
import { z } from 'zod';
import { getConfig } from './config.js';
import { runAgent } from './runner/agent-runner.js';
import { runRouter } from './router/index.js';
import { runPipeline } from './pipeline/index.js';
import { startWorker, stopWorker, isWorkerRunning } from './runner/worker.js';
import { getMcpClient, closeMcpClient } from './mcp/client.js';

const config = getConfig();
const PORT   = Number(process.env['ORCHESTRATOR_PORT'] ?? config.orchestrator.port);
const HOST   = process.env['ORCHESTRATOR_HOST'] ?? config.orchestrator.host;

const app = Fastify({ logger: true });

app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try { done(null, JSON.parse(body as string)); }
  catch (err) { done(err as Error, undefined); }
});

// POST /run — run a single agent directly (no queue)
app.post('/run', async (request, reply) => {
  const body = z.object({
    agentName:     z.string().min(1),
    task:          z.string().min(1),
    projectId:     z.string().optional(),
    maxIterations: z.number().int().min(1).max(200).optional(),
  }).parse(request.body);

  try {
    const result = await runAgent(body);
    reply.send(result);
  } catch (err) {
    reply.status(500).send({ error: String(err) });
  }
});

// POST /pipeline — run the full pipeline end-to-end (route → orchestrate → run queue)
app.post('/pipeline', async (request, reply) => {
  const body = z.object({
    prompt:    z.string().min(1),
    projectId: z.string().optional(),
    pollMs:    z.number().int().min(500).optional(),
  }).parse(request.body);

  try {
    const result = await runPipeline(body);
    reply.send(result);
  } catch (err) {
    reply.status(500).send({ error: String(err) });
  }
});

// POST /route — run the full router tier (understander → classifier → token-estimator)
app.post('/route', async (request, reply) => {
  const body = z.object({
    prompt:    z.string().min(1),
    projectId: z.string().optional(),
  }).parse(request.body);

  try {
    const result = await runRouter(body);
    reply.send(result);
  } catch (err) {
    reply.status(500).send({ error: String(err) });
  }
});

// POST /worker/start — start the queue worker
app.post('/worker/start', async (request, reply) => {
  const body = z.object({
    projectId: z.string().optional(),
    pollMs:    z.number().int().min(500).optional(),
  }).parse(request.body ?? {});

  if (isWorkerRunning()) {
    reply.send({ started: false, reason: 'already running' });
    return;
  }

  startWorker(body.projectId, body.pollMs).catch(err =>
    app.log.error('worker error:', err)
  );
  reply.send({ started: true });
});

// POST /worker/stop
app.post('/worker/stop', async (_request, reply) => {
  stopWorker();
  reply.send({ stopped: true });
});

// GET /worker/status
app.get('/worker/status', async (_request, reply) => {
  reply.send({ running: isWorkerRunning() });
});

// POST /queue — proxy to MCP agent.queue_status
app.post('/queue', async (request, reply) => {
  const body = z.object({ projectId: z.string().optional() }).parse(request.body ?? {});
  const mcp  = await getMcpClient();
  const res  = await mcp.callTool({ name: 'agent.queue_status', arguments: { projectId: body.projectId } });
  const text = (res.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '[]';
  reply.send({ rows: JSON.parse(text) });
});

// POST /logs — proxy to MCP project.get_logs
app.post('/logs', async (request, reply) => {
  const body = z.object({ projectId: z.string().optional(), limit: z.number().optional() }).parse(request.body ?? {});
  const mcp  = await getMcpClient();
  const res  = await mcp.callTool({ name: 'project.get_logs', arguments: { projectId: body.projectId, limit: body.limit } });
  const text = (res.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '[]';
  reply.send({ rows: JSON.parse(text) });
});

// POST /budget — proxy to MCP token.check_budget
app.post('/budget', async (request, reply) => {
  const body = z.object({ projectId: z.string().optional() }).parse(request.body ?? {});
  const mcp  = await getMcpClient();
  const res  = await mcp.callTool({ name: 'token.check_budget', arguments: { projectId: body.projectId } });
  const text = (res.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}';
  reply.send(JSON.parse(text));
});

// POST /budget/set — proxy to MCP token.set_limit
app.post('/budget/set', async (request, reply) => {
  const body = z.object({ limitTokens: z.number().int().min(1), projectId: z.string().optional() }).parse(request.body);
  const mcp  = await getMcpClient();
  await mcp.callTool({ name: 'token.set_limit', arguments: { limitTokens: body.limitTokens, projectId: body.projectId } });
  reply.send({ ok: true });
});

// POST /forge — run Prometheus to create a new agent
app.post('/forge', async (request, reply) => {
  const body = z.object({
    name:        z.string().min(1).regex(/^[a-z0-9-]+$/),
    tier:        z.enum(['router-tier', 'core-tier', 'specialist-tier']).optional(),
    description: z.string().min(10),
  }).parse(request.body);

  const tier = body.tier ?? 'specialist-tier';
  const task = [
    `Create a new agent with the following specification:`,
    ``,
    `name: ${body.name}`,
    `tier: ${tier}`,
    `description: ${body.description}`,
  ].join('\n');

  try {
    const result = await runAgent({ agentName: 'prometheus', task });
    reply.send({ name: body.name, tier, output: result.output });
  } catch (err) {
    reply.status(500).send({ error: String(err) });
  }
});

// GET /health
app.get('/health', async (_request, reply) => {
  reply.send({ status: 'ok', service: 'pantheon-orchestrator', workerRunning: isWorkerRunning() });
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Pantheon Orchestrator on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

async function shutdown() {
  stopWorker();
  await closeMcpClient();
  await app.close();
  process.exit(0);
}
process.on('SIGINT',  () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
