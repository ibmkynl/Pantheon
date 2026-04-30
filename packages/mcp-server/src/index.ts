import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { initSchema } from './db/index.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerFileTools } from './tools/file.js';
import { registerTodoTools } from './tools/todo.js';
import { registerAgentTools } from './tools/agent.js';
import { registerProjectTools } from './tools/project.js';
import { SseEmitter } from './sse.js';

const PORT = Number(process.env['MCP_PORT'] ?? 3100);
const HOST = process.env['MCP_HOST'] ?? 'localhost';
const TOOL_COUNT = 32;

initSchema();

const sseEmitter = new SseEmitter();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'pantheon-mcp-server', version: '0.1.0' });
  registerMemoryTools(server);
  registerFileTools(server);
  registerTodoTools(server);
  registerAgentTools(server, sseEmitter);
  registerProjectTools(server);
  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

const app = Fastify({ logger: true });

// Pre-parsed body from Fastify is passed directly to the transport
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

// POST /mcp — Streamable HTTP MCP transport
app.post('/mcp', async (request, reply) => {
  const sessionId = request.headers['mcp-session-id'] as string | undefined;
  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(request.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
    } else {
      reply.status(400).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session ID or not an initialize request' },
        id: null,
      });
      return;
    }

    // Pass raw Node.js req/res — transport owns the response from here
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch (err) {
    app.log.error(err);
    if (!reply.raw.headersSent) {
      reply.status(500).send({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// GET /mcp — MCP protocol SSE stream (resumability)
app.get('/mcp', async (request, reply) => {
  const sessionId = request.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    reply.status(400).send('Invalid or missing session ID');
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(request.raw, reply.raw);
});

// DELETE /mcp — session termination
app.delete('/mcp', async (request, reply) => {
  const sessionId = request.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    reply.status(400).send('Invalid or missing session ID');
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(request.raw, reply.raw);
});

// GET /events — custom SSE for live CLI/UI updates
app.get('/events', async (request, reply) => {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders();
  reply.raw.write(': connected\n\n');

  sseEmitter.addClient(reply);

  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  request.raw.on('close', () => {
    clearInterval(heartbeat);
    sseEmitter.removeClient(reply);
  });

  // Suspend until client disconnects
  await new Promise<void>((resolve) => {
    request.raw.on('close', resolve);
  });
});

// GET /health
app.get('/health', async (_request, reply) => {
  reply.send({ status: 'ok', tools: TOOL_COUNT });
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Pantheon MCP Server listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

process.on('SIGINT', async () => {
  app.log.info('Shutting down...');
  for (const [sid, transport] of transports) {
    try { await transport.close(); } catch { /* ignore */ }
    transports.delete(sid);
  }
  await app.close();
  process.exit(0);
});
