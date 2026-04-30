import { getMcpClient, resetMcpClient } from '../mcp/client.js';
import { getConfig } from '../config.js';
import { runAgent } from './agent-runner.js';

interface QueueEntry {
  id:        string;
  agentName: string;
  domain:    string;
  task:      string;
}

let _stopRequested = false;
let _running       = false;

async function processEntry(entry: QueueEntry, projectId?: string): Promise<void> {
  const mcp = await getMcpClient();
  console.log(`[worker] ▶ ${entry.agentName} (${entry.id.slice(0, 8)})`);

  try {
    const result = await runAgent({
      agentName:  entry.agentName,
      task:       entry.task,
      projectId,
    });

    await mcp.callTool({
      name:      'agent.queue_complete',
      arguments: { id: entry.id, result: result.output },
    });

    await mcp.callTool({
      name:      'agent.emit_event',
      arguments: {
        agentName: entry.agentName,
        type:      'agent.complete',
        message:   `${entry.agentName} finished in ${result.iterations} iterations (${result.toolCallCount} tool calls)`,
        data:      { id: entry.id },
      },
    });

    console.log(`[worker] ✓ ${entry.agentName} — ${result.iterations} iter, ${result.toolCallCount} tools`);
  } catch (err) {
    const errorMessage = String(err);
    await mcp.callTool({
      name:      'agent.queue_error',
      arguments: { id: entry.id, errorMessage },
    });
    await mcp.callTool({
      name:      'agent.emit_event',
      arguments: {
        agentName: entry.agentName,
        type:      'agent.error',
        message:   errorMessage,
        data:      { id: entry.id },
      },
    });
    console.error(`[worker] ✗ ${entry.agentName}:`, errorMessage);
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '{}';
  const block = (content as Array<{ type: string; text?: string }>).find(c => c.type === 'text');
  return block?.text ?? '{}';
}

export async function startWorker(projectId?: string, pollMs = 2000): Promise<void> {
  if (_running) return;
  _running       = true;
  _stopRequested = false;

  const maxParallel = getConfig().limits.max_parallel_specialists;
  const inFlight    = new Set<string>();

  console.log(`[worker] started (maxParallel=${maxParallel}, poll=${pollMs}ms)`);

  while (!_stopRequested) {
    try {
      if (inFlight.size < maxParallel) {
        const mcp    = await getMcpClient();
        const result = await mcp.callTool({
          name:      'agent.queue_next',
          arguments: { projectId },
        });

        const { ready } = JSON.parse(extractText(result.content)) as { ready: QueueEntry[] };

        for (const entry of ready) {
          if (inFlight.size >= maxParallel) break;
          inFlight.add(entry.id);
          processEntry(entry, projectId).finally(() => inFlight.delete(entry.id));
        }
      }
    } catch (err) {
      console.error('[worker] poll error:', err);
      // Reset MCP client so the next poll attempt reconnects
      resetMcpClient();
    }

    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
  }

  // Drain in-flight agents before returning
  while (inFlight.size > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, 200));
  }

  _running = false;
  console.log('[worker] stopped');
}

export function stopWorker(): void {
  _stopRequested = true;
}

export function isWorkerRunning(): boolean {
  return _running;
}
