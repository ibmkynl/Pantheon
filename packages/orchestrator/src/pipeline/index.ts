import { runRouter } from '../router/index.js';
import { runAgent } from '../runner/agent-runner.js';
import { startWorker, stopWorker, isWorkerRunning } from '../runner/worker.js';
import { getMcpClient } from '../mcp/client.js';

export interface PipelineInput {
  prompt:     string;
  projectId?: string;
  pollMs?:    number;
}

export interface PipelineOutput {
  projectId:      string;
  classification: string;
  routeTo:        string;
  output:         string;
  agentsRun:      number;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '{}';
  const b = (content as Array<{ type: string; text?: string }>).find(c => c.type === 'text');
  return b?.text ?? '{}';
}

async function waitForQueue(projectId: string, pollMs = 2000, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const mcp = await getMcpClient();

  while (Date.now() < deadline) {
    const res = await mcp.callTool({ name: 'agent.queue_status', arguments: { projectId } });
    const rows = JSON.parse(extractText(res.content)) as Array<{ status: string }>;

    const active = rows.filter(r => r.status === 'queued' || r.status === 'running');
    const errors  = rows.filter(r => r.status === 'error');

    if (errors.length > 0) {
      throw new Error(`${errors.length} agent(s) errored. Check logs with: pantheon logs --project ${projectId}`);
    }
    if (active.length === 0) return; // all done

    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
  }

  throw new Error(`Pipeline timed out after ${timeoutMs / 1000}s`);
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const pollMs = input.pollMs ?? 2000;

  // Phase A — Router tier
  const route = await runRouter({
    prompt:    input.prompt,
    projectId: input.projectId,
  });

  if (route.tokenDecision === 'blocked') {
    throw new Error('Token budget exceeded. Use `pantheon budget set <n>` to increase it.');
  }

  // Phase B — Simple path: btw-agent handles it directly
  if (route.routeTo === 'btw-agent' || route.classification === 'simple') {
    const result = await runAgent({
      agentName: 'btw-agent',
      task:      input.prompt,
      projectId: route.projectId,
    });
    return {
      projectId:      route.projectId,
      classification: route.classification,
      routeTo:        'btw-agent',
      output:         result.output,
      agentsRun:      4, // 3 router + btw
    };
  }

  // Phase C — Full task path: orchestrator decomposes into queue, worker runs it
  // 1. Create project
  const mcp = await getMcpClient();
  await mcp.callTool({
    name:      'project.update',
    arguments: {
      projectId: route.projectId,
      fields: { name: route.understood.intent.slice(0, 80), status: 'running' },
    },
  });

  // 2. Run orchestrator agent to populate the queue
  await runAgent({
    agentName: 'orchestrator',
    task:      `Decompose this task and populate the agent queue.\n\nProject ID: ${route.projectId}\nUser prompt: ${input.prompt}\n\nThe understander and classifier results are already in memory.`,
    projectId: route.projectId,
  });

  // 3. Start worker for this project if not already running
  const workerWasRunning = isWorkerRunning();
  if (!workerWasRunning) {
    void startWorker(route.projectId, pollMs);
  }

  // 4. Wait for the entire queue to drain
  await waitForQueue(route.projectId, pollMs);

  if (!workerWasRunning) {
    stopWorker();
  }

  // 5. Mark project done
  await mcp.callTool({
    name:      'project.update',
    arguments: { projectId: route.projectId, fields: { status: 'done' } },
  });

  // 6. Count agents that ran
  const finalRes = await mcp.callTool({ name: 'agent.queue_status', arguments: { projectId: route.projectId } });
  const finalRows = JSON.parse(extractText(finalRes.content)) as Array<{ status: string }>;
  const agentsRun = finalRows.filter(r => r.status === 'done').length + 3; // +3 router agents

  return {
    projectId:      route.projectId,
    classification: route.classification,
    routeTo:        'orchestrator',
    output:         `Project ${route.projectId} complete. ${agentsRun} agents ran. Check files with: pantheon queue --project ${route.projectId}`,
    agentsRun,
  };
}
